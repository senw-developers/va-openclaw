import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMediaUploaderForTests,
  registerMediaUploader,
  type MediaUploadInput,
} from "../../../plugin-sdk/media-uploader.js";
import mediaUploadExtension from "./extension.js";

type ResultHandler = (
  event: ToolResultEvent,
  ctx: unknown,
) => Promise<ToolResultEventResult | void> | ToolResultEventResult | void;

function captureToolResultHandler(): ResultHandler {
  let captured: ResultHandler | undefined;
  const api = {
    on: (event: string, handler: ResultHandler) => {
      if (event === "tool_result") captured = handler;
    },
  } as unknown as ExtensionAPI;
  mediaUploadExtension(api);
  if (!captured) throw new Error("extension did not register a tool_result handler");
  return captured;
}

function deliverEvent(deliverables: Array<{ path: unknown }>): ToolResultEvent {
  return {
    type: "tool_result",
    toolName: "deliver",
    toolCallId: "call_1",
    input: {},
    content: [{ type: "text", text: "Delivered report.csv (8 B)" }],
    isError: false,
    details: { deliverables },
  } as unknown as ToolResultEvent;
}

describe("media-upload extension — details.deliverables[]", () => {
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

    const handler = captureToolResultHandler();
    const res = (await handler(
      deliverEvent([{ path: "/home/node/.openclaw/workspace/report.csv" }]),
      {},
    )) as ToolResultEventResult;

    expect(calls).toHaveLength(1);
    expect(calls[0].filePath).toBe("/home/node/.openclaw/workspace/report.csv");

    const details = (res.details ?? {}) as {
      nabuFileIds?: number[];
      media?: { mediaUrls?: string[] };
    };
    expect(details.nabuFileIds).toContain(42); // web fileRefs path
    expect(details.media?.mediaUrls).toContain("https://signed.example/files/42.csv"); // channel path

    // Original block unchanged; a URL-free delivery confirmation is appended
    // so the model knows it succeeded and stops regenerating/re-delivering.
    const blocks = res.content as Array<{ type: string; text: string }>;
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
    const handler = captureToolResultHandler();
    const res = await handler(
      deliverEvent([{ path: "https://example.com/already-remote.pdf" }]),
      {},
    );
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
    const handler = captureToolResultHandler();
    await handler(deliverEvent([{ path: "/ws/f.bin" }, { path: "/ws/f.bin" }]), {});
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
