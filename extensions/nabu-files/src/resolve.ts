import { Buffer } from "node:buffer";
import * as http from "node:http";
import * as https from "node:https";
import type { OpenClawPluginApi } from "../api.js";
import { resolveTenantAuth } from "./broker.js";
import { getLivePluginConfig } from "./config.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOG_PREFIX,
  RESOLVE_BATCH_MAX,
  SKILL_RESOLVE_PATH,
} from "./nabu-files.constants.js";
import type {
  FilesApiErrorEnvelope,
  NabuFilesConfig,
  ResolveResponse,
  ResolvedFile,
} from "./nabu-files.interface.js";
import { isRetryableHttpError, withBackoff } from "./retry.js";

class ResolveHttpError extends Error {
  readonly statusCode: number;
  readonly body: unknown;
  constructor(statusCode: number, body: unknown, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Chunks at RESOLVE_BATCH_MAX (100); the backend rejects larger batches.
 */
export async function resolveFiles(
  api: OpenClawPluginApi,
  fileIds: number[],
  opts?: { expirySeconds?: number; requestId?: string; userId?: string; agentId?: string },
): Promise<ResolvedFile[]> {
  if (fileIds.length === 0) return [];

  const cfg = getLivePluginConfig(api);
  // Per-user isolation: resolve must be authorized as an owner. Numeric check
  // mirrors upload — the backend keys ownership on the numeric app user id, so
  // a channel-native senderId would resolve against the wrong (or no) owner.
  const userId = opts?.userId;
  if (typeof userId !== "string" || !/^\d+$/.test(userId)) {
    throw new Error(`${LOG_PREFIX} non-numeric userId on resolve; refusing (per-user isolation)`);
  }
  // Composed tenancy (G1): org + skill token together. Config token + env org on
  // a dedicated tenant, else a per-org brokered token for the shared instance.
  const { organizationId, skillToken } = await resolveTenantAuth(cfg, opts?.agentId);

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
          userId,
          organizationId,
          skillToken,
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
  userId: string;
  organizationId: string;
  skillToken: string;
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
    "x-skill-token": input.skillToken,
    "x-organization-id": input.organizationId,
    "x-user-id": input.userId,
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
          let body: FilesApiErrorEnvelope | string = text;
          try {
            body = JSON.parse(text) as FilesApiErrorEnvelope;
          } catch {
            /* keep raw text */
          }
          reject(
            new ResolveHttpError(
              status,
              body,
              // Body in the message on purpose: the backend's error envelope
              // (code/message/data) is the only diagnostic for a failed batch.
              `${LOG_PREFIX} skill-resolve returned ${status}: ${JSON.stringify(body).slice(0, 300)}`,
            ),
          );
        });
      },
    );
    req.on("error", (err) =>
      reject(new Error(`${LOG_PREFIX} skill-resolve network error: ${err.message}`)),
    );
    req.on("timeout", () => {
      req.destroy(new Error(`${LOG_PREFIX} skill-resolve timeout after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}
