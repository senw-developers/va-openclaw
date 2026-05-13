import { Buffer } from "node:buffer";
import * as http from "node:http";
import * as https from "node:https";

import type { OpenClawPluginApi } from "../api.js";
import { getLivePluginConfig, hasApiToken } from "./config.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOG_PREFIX,
  RESOLVE_BATCH_MAX,
  SKILL_RESOLVE_PATH,
} from "./nabu-files.constants.js";
import type { NabuFilesConfig, ResolveResponse, ResolvedFile } from "./nabu-files.interface.js";
import { isRetryableHttpError, withBackoff } from "./retry.js";

// Chunks at RESOLVE_BATCH_MAX (100); backend rejects larger batches.
export async function resolveFiles(
  api: OpenClawPluginApi,
  fileIds: number[],
  opts?: { expirySeconds?: number; requestId?: string },
): Promise<ResolvedFile[]> {
  if (fileIds.length === 0) return [];

  const cfg = getLivePluginConfig(api);
  if (!hasApiToken(cfg)) {
    throw new Error(`${LOG_PREFIX} apiToken not configured`);
  }
  const organizationId = process.env.OPENCLAW_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error(`${LOG_PREFIX} OPENCLAW_ORGANIZATION_ID not set`);
  }

  const maxAttempts = Math.max(1, cfg.maxRetries ?? 3);
  const chunks = chunk(fileIds, RESOLVE_BATCH_MAX);
  const out: ResolvedFile[] = [];

  for (const ids of chunks) {
    const result = await withBackoff({
      attempts: maxAttempts,
      shouldRetry: isRetryableHttpError,
      run: () =>
        postSkillResolve({
          cfg,
          organizationId,
          requestId: opts?.requestId,
          fileIds: ids,
          expirySeconds: opts?.expirySeconds,
        }),
    });
    out.push(...result.files);
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function postSkillResolve(input: {
  cfg: NabuFilesConfig;
  organizationId: string;
  requestId: string | undefined;
  fileIds: number[];
  expirySeconds: number | undefined;
}): Promise<ResolveResponse> {
  const baseUrl = input.cfg.apiBaseUrl ?? "http://app:6001";
  const url = new URL(SKILL_RESOLVE_PATH, baseUrl);
  const payload = JSON.stringify({
    fileIds: input.fileIds,
    ...(input.expirySeconds !== undefined ? { expirySeconds: input.expirySeconds } : {}),
  });
  const body = Buffer.from(payload, "utf8");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
    "x-skill-token": input.cfg.apiToken,
    "x-organization-id": input.organizationId,
  };
  if (input.requestId) headers["X-Request-Id"] = input.requestId;

  const transport = url.protocol === "https:" ? https : http;
  const timeoutMs = input.cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(text) as ResolveResponse);
            } catch (err) {
              reject(new Error(`${LOG_PREFIX} skill-resolve: bad JSON: ${(err as Error).message}`));
            }
            return;
          }
          const httpErr = new Error(`${LOG_PREFIX} skill-resolve returned ${status}: ${text}`);
          (httpErr as Error & { statusCode?: number }).statusCode = status;
          reject(httpErr);
        });
      },
    );
    req.on("error", (err) => reject(new Error(`${LOG_PREFIX} skill-resolve network error: ${err.message}`)));
    req.on("timeout", () => {
      req.destroy(new Error(`${LOG_PREFIX} skill-resolve timeout after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}
