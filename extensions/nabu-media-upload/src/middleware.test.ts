import type {
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
} from "openclaw/plugin-sdk/agent-harness";
import {
  __resetMediaUploaderForTests,
  type MediaUploadInput,
  registerMediaUploader,
} from "openclaw/plugin-sdk/media-uploader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaUploadAgentToolResultMiddleware } from "./middleware.js";

const CTX: AgentToolResultMiddlewareContext = { runtime: "openclaw" };

function deliverEvent(deliverables: Array<{ path: unknown }>): AgentToolResultMiddlewareEvent {
  return {
    toolCallId: "call_1",
    toolName: "deliver",
    args: {},
    isError: false,
    result: {
      content: [{ type: "text", text: "Delivered report.csv (8 B)" }],
      details: { deliverables },
      isError: false,
    },
  } as unknown as AgentToolResultMiddlewareEvent;
}

describe("nabu media-upload middleware — details.deliverables[]", () => {
  beforeEach(() => __resetMediaUploaderForTests());
  afterEach(() => __resetMediaUploaderForTests());

  it("uploads a deliverable and stamps both surfaces (nabuFileIds + media.mediaUrls)", async () => {
    const calls: MediaUploadInput[] = [];
    registerMediaUploader(async (input) => {
      calls.push(input);
      return {
        fileId: 42,
        signedUrl: "https://signed.example/files/42.csv",
        signedUrlExpiresAt: "2030-01-01T00:00:00Z",
        name: "report.csv",
        mimeType: "text/csv",
        sizeBytes: 8,
      };
    });

    const middleware = createMediaUploadAgentToolResultMiddleware();
    const res = await middleware(
      deliverEvent([{ path: "/home/node/.openclaw/workspace/report.csv" }]),
      CTX,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].filePath).toBe("/home/node/.openclaw/workspace/report.csv");
    expect(res).toBeTruthy();

    const details = (res?.result.details ?? {}) as {
      nabuFileIds?: number[];
      media?: { mediaUrls?: string[] };
    };
    expect(details.nabuFileIds).toContain(42); // web fileRefs path
    expect(details.media?.mediaUrls).toContain("https://signed.example/files/42.csv"); // channel path

    // Original block unchanged; a URL-free delivery confirmation is appended
    // so the model knows it succeeded and stops regenerating/re-delivering.
    const blocks = res?.result.content as Array<{ type: string; text: string }>;
    expect(blocks[0].text).toBe("Delivered report.csv (8 B)");
    const joined = blocks.map((b) => b.text).join("\n");
    expect(joined).not.toContain("signed.example");
    expect(joined).toMatch(/delivered to the user and available for download/i);
    expect(joined).toMatch(/do not regenerate/i);
  });

  it("skips http(s) deliverable paths (nothing to upload)", async () => {
    const upload = vi.fn(async () => ({
      fileId: 1,
      signedUrl: "x",
      signedUrlExpiresAt: "x",
      name: "x",
      mimeType: "x",
      sizeBytes: 0,
    }));
    registerMediaUploader(upload);
    const middleware = createMediaUploadAgentToolResultMiddleware();
    const res = await middleware(deliverEvent([{ path: "https://example.com/already-remote.pdf" }]), CTX);
    expect(upload).not.toHaveBeenCalled();
    expect(res).toBeUndefined(); // no candidates → no rewrite
  });

  it("dedupes a repeated path within one result", async () => {
    const upload = vi.fn(async () => ({
      fileId: 7,
      signedUrl: "https://signed.example/7.bin",
      signedUrlExpiresAt: "2030-01-01T00:00:00Z",
      name: "f.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 3,
    }));
    registerMediaUploader(upload);
    const middleware = createMediaUploadAgentToolResultMiddleware();
    await middleware(deliverEvent([{ path: "/ws/f.bin" }, { path: "/ws/f.bin" }]), CTX);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
