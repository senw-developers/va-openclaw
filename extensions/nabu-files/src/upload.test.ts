import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:http BEFORE importing upload.ts.
vi.mock("node:http", () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});
vi.mock("node:https", () => {
  const mockRequest = vi.fn();
  return { default: { request: mockRequest }, request: mockRequest };
});

const http = await import("node:http");
const { uploadFile, __resetUploadCachesForTests } = await import("./upload.js");

type LoggerStub = {
  error: (msg: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
  debug: (msg: string) => void;
};
function stubApi(): {
  api: Parameters<typeof uploadFile>[0];
  logger: LoggerStub;
} {
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
  } as unknown as Parameters<typeof uploadFile>[0];
  return { api, logger };
}

type CapturedRequest = {
  options: RequestOptions & { headers?: Record<string, string> };
  bodyChunks: Buffer[];
};

function captureRequestAndRespond(statusCode: number, responseBody: string): CapturedRequest {
  const captured: CapturedRequest = { options: {}, bodyChunks: [] };
  const httpRequest = vi.mocked(http.request);
  httpRequest.mockImplementation(((...args) => {
    const options = args[0] as RequestOptions & { headers?: Record<string, string> };
    const callback = args[1] as ((res: IncomingMessage) => void) | undefined;
    captured.options = options;

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
  return captured;
}

describe("uploadFile — userId-primary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetUploadCachesForTests();
    // Composed tenancy (G1): the transport fails closed without an org id.
    process.env.OPENCLAW_ORGANIZATION_ID = "1";
  });
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_ORGANIZATION_ID;
  });

  it("refuses upload when userId is absent", async () => {
    const { api } = stubApi();
    await expect(uploadFile(api, { bytes: Buffer.from("x"), filename: "x.bin" })).rejects.toThrow(
      /non-numeric userId on upload; refusing/,
    );
  });

  it("emits x-user-id and OMITS x-channel", async () => {
    const captured = captureRequestAndRespond(
      201,
      JSON.stringify({
        fileId: 42,
        signedUrl: "https://signed.example/42",
        signedUrlExpiresAt: "2030-01-01T00:00:00Z",
        name: "x.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 1,
      }),
    );
    const { api } = stubApi();
    await uploadFile(api, {
      bytes: Buffer.from("x"),
      filename: "x.bin",
      userId: "42",
      responseId: "resp_abc",
      mediaIndex: 0,
    });
    const headers = (captured.options.headers ?? {}) as Record<string, string>;
    expect(headers["x-user-id"]).toBe("42");
    expect(headers["x-organization-id"]).toBe("1");
    expect(headers["x-skill-token"]).toBe("test-skill-token");
    expect(headers).not.toHaveProperty("x-channel");
    expect(headers["Idempotency-Key"]).toBeDefined();
  });

  it("Idempotency-Key carries user prefix and differs across users (cross-user isolation)", async () => {
    const captured1 = captureRequestAndRespond(
      201,
      JSON.stringify({
        fileId: 1,
        signedUrl: "u",
        signedUrlExpiresAt: "x",
        name: "n",
        mimeType: "m",
        sizeBytes: 1,
      }),
    );
    const { api } = stubApi();
    await uploadFile(api, {
      bytes: Buffer.from("x"),
      filename: "x.bin",
      userId: "111",
      responseId: "resp_abc",
      mediaIndex: 0,
    });
    const key1 = (captured1.options.headers ?? {})["Idempotency-Key"] as string;

    __resetUploadCachesForTests();
    const captured2 = captureRequestAndRespond(
      201,
      JSON.stringify({
        fileId: 2,
        signedUrl: "u",
        signedUrlExpiresAt: "x",
        name: "n",
        mimeType: "m",
        sizeBytes: 1,
      }),
    );
    await uploadFile(api, {
      bytes: Buffer.from("x"),
      filename: "x.bin",
      userId: "222",
      responseId: "resp_abc",
      mediaIndex: 0,
    });
    const key2 = (captured2.options.headers ?? {})["Idempotency-Key"] as string;

    expect(key1).toMatch(/^u:111:/);
    expect(key2).toMatch(/^u:222:/);
    expect(key1).not.toEqual(key2);
  });

  describe("Idempotency-Key 128-char cap", () => {
    function buildSetup() {
      const captured = captureRequestAndRespond(
        201,
        JSON.stringify({
          fileId: 1,
          signedUrl: "u",
          signedUrlExpiresAt: "x",
          name: "n",
          mimeType: "m",
          sizeBytes: 1,
        }),
      );
      const { api } = stubApi();
      return { captured, api };
    }

    const longToolCallId = "call_" + "x".repeat(200);
    const longResponseId = "resp_" + "y".repeat(100);

    it("deterministic: same long inputs → same key, length <= 128", async () => {
      const a = buildSetup();
      await uploadFile(a.api, {
        bytes: Buffer.from("x"),
        filename: "x.bin",
        userId: "10",
        responseId: longResponseId,
        toolCallId: longToolCallId,
      });
      const keyA = (a.captured.options.headers ?? {})["Idempotency-Key"] as string;
      __resetUploadCachesForTests();

      const b = buildSetup();
      await uploadFile(b.api, {
        bytes: Buffer.from("x"),
        filename: "x.bin",
        userId: "10",
        responseId: longResponseId,
        toolCallId: longToolCallId,
      });
      const keyB = (b.captured.options.headers ?? {})["Idempotency-Key"] as string;

      expect(keyA.length).toBeLessThanOrEqual(128);
      expect(keyA).toBe(keyB);
      expect(keyA.startsWith("u:10:")).toBe(true);
    });

    it("collision-resistant: different long inputs, same userId → different keys", async () => {
      const a = buildSetup();
      await uploadFile(a.api, {
        bytes: Buffer.from("x"),
        filename: "x.bin",
        userId: "10",
        responseId: longResponseId,
        toolCallId: "call_" + "a".repeat(200),
      });
      const keyA = (a.captured.options.headers ?? {})["Idempotency-Key"] as string;
      __resetUploadCachesForTests();

      const b = buildSetup();
      await uploadFile(b.api, {
        bytes: Buffer.from("x"),
        filename: "x.bin",
        userId: "10",
        responseId: longResponseId,
        toolCallId: "call_" + "b".repeat(200),
      });
      const keyB = (b.captured.options.headers ?? {})["Idempotency-Key"] as string;

      expect(keyA.length).toBeLessThanOrEqual(128);
      expect(keyB.length).toBeLessThanOrEqual(128);
      expect(keyA).not.toEqual(keyB);
    });

    it("pathological 200-char userId still produces key <= 128 (defense-in-depth hash of userId)", async () => {
      // Numeric on purpose (T5): non-numeric ids are refused before
      // key-building; this case exercises the sha1-capped prefix path.
      const longUserId = "1".repeat(200);
      const a = buildSetup();
      await uploadFile(a.api, {
        bytes: Buffer.from("x"),
        filename: "x.bin",
        userId: longUserId,
        responseId: "resp_abc",
        mediaIndex: 0,
      });
      const key = (a.captured.options.headers ?? {})["Idempotency-Key"] as string;
      expect(key.length).toBeLessThanOrEqual(128);
      expect(key.startsWith("u:")).toBe(true);
    });

    it("cross-user isolated: same long input, different userIds → different keys (preserves u:<id>: prefix)", async () => {
      const a = buildSetup();
      await uploadFile(a.api, {
        bytes: Buffer.from("x"),
        filename: "x.bin",
        userId: "10",
        responseId: longResponseId,
        toolCallId: longToolCallId,
      });
      const keyA = (a.captured.options.headers ?? {})["Idempotency-Key"] as string;
      __resetUploadCachesForTests();

      const b = buildSetup();
      await uploadFile(b.api, {
        bytes: Buffer.from("x"),
        filename: "x.bin",
        userId: "20",
        responseId: longResponseId,
        toolCallId: longToolCallId,
      });
      const keyB = (b.captured.options.headers ?? {})["Idempotency-Key"] as string;

      expect(keyA.startsWith("u:10:")).toBe(true);
      expect(keyB.startsWith("u:20:")).toBe(true);
      expect(keyA).not.toEqual(keyB);
    });
  });
});
