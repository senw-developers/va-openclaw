import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { basename } from "node:path";

import type { OpenClawPluginApi } from "../api.js";
import { getLivePluginConfig, hasApiToken } from "./config.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOG_PREFIX,
  SKILL_UPLOAD_PATH,
} from "./nabu-files.constants.js";
import type { FileResource, FilesApiErrorEnvelope, NabuFilesConfig } from "./nabu-files.interface.js";
import { isRetryableHttpError, withBackoff } from "./retry.js";

// Keyed by Idempotency-Key so the upstream uploader and the tool_result_persist
// hook agree on fileIds without re-POSTing. Secondary toolCallId index lets the
// sync hook look up ids when it only has the tool call id.
const uploadCache = new Map<string, FileResource>();
const toolCallIndex = new Map<string, number[]>();

function pickFileId(file: FileResource): number | undefined {
  return file.fileId ?? file.id;
}

class UploadHttpError extends Error {
  readonly statusCode: number;
  readonly body: unknown;
  constructor(statusCode: number, body: unknown, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.body = body;
  }
}

export type UploadCallOptions = {
  filePath?: string;
  bytes?: Buffer;
  filename?: string;
  mimeHint?: string;
  responseId?: string;
  mediaIndex?: number;
  toolCallId?: string;
  source?: string;
};

export async function uploadFile(
  api: OpenClawPluginApi,
  input: UploadCallOptions,
): Promise<FileResource> {
  const cfg = getLivePluginConfig(api);
  if (!hasApiToken(cfg)) {
    throw new Error(`${LOG_PREFIX} apiToken not configured`);
  }
  const organizationId = process.env.OPENCLAW_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error(`${LOG_PREFIX} OPENCLAW_ORGANIZATION_ID not set`);
  }

  const key = buildIdempotencyKey(input);

  const cached = uploadCache.get(key);
  if (cached) {
    const cachedId = pickFileId(cached);
    if (cachedId !== undefined) indexByToolCall(input.toolCallId, cachedId);
    return cached;
  }

  const bytes =
    input.bytes ?? (input.filePath ? await readFile(input.filePath) : Buffer.alloc(0));
  if (bytes.length === 0) {
    throw new Error(`${LOG_PREFIX} no bytes to upload (filePath=${input.filePath})`);
  }
  const filename = input.filename ?? (input.filePath ? basename(input.filePath) : "upload.bin");
  const contentType = input.mimeHint ?? "application/octet-stream";

  const maxAttempts = Math.max(1, cfg.maxRetries ?? 3);

  try {
    const file = await withBackoff({
      attempts: maxAttempts,
      shouldRetry: isRetryableHttpError,
      run: () =>
        postSkillUpload({
          cfg,
          organizationId,
          idempotencyKey: key,
          requestId: input.responseId,
          filename,
          contentType,
          bytes,
        }),
    });
    uploadCache.set(key, file);
    const newId = pickFileId(file);
    if (newId !== undefined) indexByToolCall(input.toolCallId, newId);
    return file;
  } catch (err) {
    await logFailure(api, err, input, bytes.length);
    throw err;
  }
}

export function getFileIdsForToolCall(toolCallId: string | undefined): number[] {
  if (!toolCallId) return [];
  return toolCallIndex.get(toolCallId) ?? [];
}

export function __resetUploadCachesForTests(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error("__resetUploadCachesForTests is only available in test environments");
  }
  uploadCache.clear();
  toolCallIndex.clear();
}

// ---------------------------------------------------------------------------

function buildIdempotencyKey(input: UploadCallOptions): string {
  if (input.responseId && input.mediaIndex !== undefined) {
    return `${input.responseId}:${input.mediaIndex}`;
  }
  if (input.responseId && input.toolCallId) {
    return `${input.responseId}:${input.toolCallId}`;
  }
  if (input.toolCallId) {
    return `toolcall:${input.toolCallId}`;
  }
  // Fallback - random key so we still upload but don't share idempotency.
  return `nf:${randomBytes(8).toString("hex")}`;
}

function indexByToolCall(toolCallId: string | undefined, fileId: number): void {
  if (!toolCallId) return;
  const list = toolCallIndex.get(toolCallId);
  if (list) {
    if (!list.includes(fileId)) list.push(fileId);
  } else {
    toolCallIndex.set(toolCallId, [fileId]);
  }
}

// ---------------------------------------------------------------------------
// Multipart POST
// ---------------------------------------------------------------------------

type PostInput = {
  cfg: NabuFilesConfig;
  organizationId: string;
  idempotencyKey: string;
  requestId: string | undefined;
  filename: string;
  contentType: string;
  bytes: Buffer;
};

async function postSkillUpload(input: PostInput): Promise<FileResource> {
  const baseUrl = input.cfg.apiBaseUrl ?? "http://app:6001";
  const url = new URL(SKILL_UPLOAD_PATH, baseUrl);
  const boundary = `----nabu-files-${randomBytes(16).toString("hex")}`;
  const body = encodeMultipart(boundary, input.filename, input.contentType, input.bytes);
  const headers: Record<string, string> = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(body.length),
    "x-skill-token": input.cfg.apiToken,
    "x-organization-id": input.organizationId,
    "Idempotency-Key": input.idempotencyKey,
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
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve(JSON.parse(text) as FileResource);
            } catch (err) {
              reject(new Error(`${LOG_PREFIX} skill-upload: bad JSON response: ${(err as Error).message}`));
            }
            return;
          }
          let body: FilesApiErrorEnvelope | string = text;
          try {
            body = JSON.parse(text) as FilesApiErrorEnvelope;
          } catch {
            /* keep raw text */
          }
          reject(new UploadHttpError(status, body, `${LOG_PREFIX} skill-upload returned ${status}`));
        });
      },
    );
    req.on("error", (err) => {
      reject(new Error(`${LOG_PREFIX} skill-upload network error: ${err.message}`));
    });
    req.on("timeout", () => {
      req.destroy(new Error(`${LOG_PREFIX} skill-upload timeout after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

function encodeMultipart(
  boundary: string,
  filename: string,
  contentType: string,
  bytes: Buffer,
): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${escapeFilename(filename)}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return Buffer.concat([head, bytes, tail]);
}

function escapeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "_");
}

async function logFailure(
  api: OpenClawPluginApi,
  err: unknown,
  input: UploadCallOptions,
  byteLen: number,
): Promise<void> {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  const errorBody = (err as { body?: unknown } | null)?.body;
  let size = byteLen;
  if (size === 0 && input.filePath) {
    try {
      size = (await stat(input.filePath)).size;
    } catch {
      /* ignore */
    }
  }
  api.logger.error(
    `${LOG_PREFIX} MEDIA_UPLOAD_FAILED status=${status ?? "n/a"} size=${size} mime=${input.mimeHint ?? "unknown"} responseId=${input.responseId ?? "n/a"} mediaIndex=${input.mediaIndex ?? "n/a"} toolCallId=${input.toolCallId ?? "n/a"} err=${err instanceof Error ? err.message : String(err)} body=${typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody ?? null)}`,
  );
}
