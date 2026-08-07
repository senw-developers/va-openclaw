import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:http", () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});
vi.mock("node:https", () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

const http = await import("node:http");
const { resolveFiles } = await import("./resolve.js");

type LoggerStub = {
  error: (msg: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
  debug: (msg: string) => void;
};
function stubApi(): Parameters<typeof resolveFiles>[0] {
  const logger: LoggerStub = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  };
  const api = {
    runtime: {
      config: {
        current: () => ({
          plugins: {
            entries: {
              "nabu-files": {
                config: {
                  apiToken: "test-skill-token",
                  apiBaseUrl: "http://app:6001",
                  requestTimeoutMs: 30_000,
                  maxRetries: 1,
                },
              },
            },
          },
        }),
      },
    },
    logger,
  } as unknown as Parameters<typeof resolveFiles>[0];
  return api;
}

type CapturedRequest = {
  options: RequestOptions & { headers?: Record<string, string> };
  bodyChunks: Buffer[];
};

function captureRequestAndRespond(statusCode: number, responseBody: string): CapturedRequest[] {
  const captures: CapturedRequest[] = [];
  const httpRequest = vi.mocked(http.request);
  httpRequest.mockImplementation(((...args) => {
    const options = args[0] as RequestOptions & { headers?: Record<string, string> };
    const callback = args[1] as ((res: IncomingMessage) => void) | undefined;
    const captured: CapturedRequest = { options, bodyChunks: [] };
    captures.push(captured);

    const req = new EventEmitter() as Partial<ClientRequest> & EventEmitter;
    req.write = ((chunk: Buffer) => {
      if (Buffer.isBuffer(chunk)) captured.bodyChunks.push(chunk);
      return true;
    }) as ClientRequest["write"];
    req.end = vi.fn() as ClientRequest["end"];
    req.destroy = vi.fn() as ClientRequest["destroy"];

    const res = new EventEmitter() as Partial<IncomingMessage> & EventEmitter;
    res.statusCode = statusCode;
    process.nextTick(() => {
      callback?.(res as IncomingMessage);
      res.emit("data", Buffer.from(responseBody, "utf8"));
      res.emit("end");
    });
    return req as ClientRequest;
  }) as Parameters<typeof http.request>[0] extends never ? never : typeof http.request);
  return captures;
}

describe("resolveFiles — userId-primary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Composed tenancy (G1): the transport fails closed without an org id.
    process.env.OPENCLAW_ORGANIZATION_ID = "1";
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_ORGANIZATION_ID;
  });

  it("returns [] for empty input without touching transport", async () => {
    const api = stubApi();
    const result = await resolveFiles(api, []);
    expect(result).toEqual([]);
    expect(vi.mocked(http.request)).not.toHaveBeenCalled();
  });

  it("refuses when userId is absent", async () => {
    const api = stubApi();
    await expect(resolveFiles(api, [1, 2, 3])).rejects.toThrow(/no userId on resolve; refusing/);
  });

  it("emits x-user-id and OMITS x-channel", async () => {
    const captures = captureRequestAndRespond(
      200,
      JSON.stringify({
        files: [
          {
            fileId: 1,
            signedUrl: "u",
            signedUrlExpiresAt: "x",
            name: "n",
            mimeType: "m",
            sizeBytes: 1,
          },
        ],
      }),
    );
    const api = stubApi();
    await resolveFiles(api, [1], { userId: "42", requestId: "req-1" });
    expect(captures).toHaveLength(1);
    const headers = (captures[0].options.headers ?? {}) as Record<string, string>;
    expect(headers["x-user-id"]).toBe("42");
    expect(headers["x-organization-id"]).toBe("1");
    expect(headers["x-skill-token"]).toBe("test-skill-token");
    expect(headers).not.toHaveProperty("x-channel");
    expect(headers["X-Request-Id"]).toBe("req-1");
  });

  it("passes per-entry discriminator (hit + miss) through unchanged", async () => {
    captureRequestAndRespond(
      200,
      JSON.stringify({
        files: [
          {
            fileId: 1,
            signedUrl: "https://signed.example/1",
            signedUrlExpiresAt: "2030-01-01T00:00:00Z",
            name: "a.bin",
            mimeType: "application/octet-stream",
            sizeBytes: 10,
          },
          { fileId: 2, error: "NOT_FOUND" },
        ],
      }),
    );
    const api = stubApi();
    const result = await resolveFiles(api, [1, 2], { userId: "42" });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ fileId: 1, signedUrl: "https://signed.example/1" });
    expect(result[1]).toMatchObject({ fileId: 2, error: "NOT_FOUND" });
  });

  it("413 FILE_QUOTA_EXCEEDED → parses FilesApiErrorEnvelope into structured error", async () => {
    captureRequestAndRespond(
      413,
      JSON.stringify({
        code: "FILE_QUOTA_EXCEEDED",
        message: "Quota exceeded",
        data: { usedBytes: 1000, limitBytes: 1024, incomingBytes: 25 },
      }),
    );
    const api = stubApi();
    let caught: unknown = undefined;
    try {
      await resolveFiles(api, [1, 2, 3], { userId: "42" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const errorObj = caught as Error & { statusCode?: number; body?: unknown };
    expect(errorObj.statusCode).toBe(413);
    expect(errorObj.body).toMatchObject({
      code: "FILE_QUOTA_EXCEEDED",
      data: { usedBytes: 1000, limitBytes: 1024, incomingBytes: 25 },
    });
  });

  it("5xx error preserves statusCode for retry classification", async () => {
    captureRequestAndRespond(500, "internal error");
    const api = stubApi();
    let caught: unknown = undefined;
    try {
      await resolveFiles(api, [1], { userId: "42" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const errorObj = caught as Error & { statusCode?: number };
    expect(errorObj.statusCode).toBe(500);
  });
});
