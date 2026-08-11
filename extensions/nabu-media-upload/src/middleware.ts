// Nabu media-upload tool-result middleware.
//
// On each agent tool result, uploads candidate media (local paths or MiniMax
// CDN URLs) via the registered media uploader before the result is folded into
// the transcript, then rewrites content/details so:
//   - details.media.mediaUrls carry signed URLs (channel delivery),
//   - details.nabuFileIds carry web fileRefs (control UI / web chat),
//   - MEDIA: markers are stripped from model-visible prose, and
//   - a URL-free "N files delivered" confirmation is appended so the model does
//     not regenerate or re-deliver.
// No-op when no uploader is registered or the tool is a built-in pi tool.
//
// Ported from the former core agent-hook (src/agents/pi-hooks/media-upload) onto
// upstream's AgentToolResultMiddleware contract (Path A: bundled plugin so core
// stays extension-agnostic).
import type {
  AgentToolResultMiddleware,
  OpenClawAgentToolResult,
} from "openclaw/plugin-sdk/agent-harness";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { splitMediaFromOutput } from "openclaw/plugin-sdk/media-parse";
import { getMediaUploader, type MediaUploadResult } from "openclaw/plugin-sdk/media-uploader";

const UPLOAD_TIMEOUT_MS = 10_000;
const HTTP_URL_RE = /^https?:\/\//i;
const MINIMAX_CDN_RE = /^https?:\/\/agent-cdn\.minimax\.io\//i;
const BUILT_IN_PI_TOOLS = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; [k: string]: unknown };
type ContentItem = TextContent | ImageContent | { type: string; [k: string]: unknown };

type DetailsMedia = {
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  [k: string]: unknown;
};

type MediaCandidate = {
  source: string;
  index: number;
};

/**
 * Minimal local timeout wrapper — the core util is not on the plugin SDK.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`media upload timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createMediaUploadAgentToolResultMiddleware(): AgentToolResultMiddleware {
  return async (event, ctx) => {
    const uploader = getMediaUploader();
    if (!uploader) return;

    if (BUILT_IN_PI_TOOLS.has(event.toolName)) return;

    const content = event.result.content as ContentItem[] | undefined;
    const details = event.result.details;

    const candidates = collectMediaCandidates(content, details);
    if (candidates.length === 0) return;

    const rewrites = new Map<string, MediaUploadResult>();
    const fileIds: number[] = [];

    await Promise.all(
      candidates.map(async (c) => {
        try {
          const mimeHint = await detectMime({ filePath: c.source });
          const result = await withTimeout(
            uploader({
              filePath: c.source,
              toolCallId: event.toolCallId,
              mediaIndex: c.index,
              source: `tool_result:${event.toolName}`,
              ...(ctx?.userId ? { userId: ctx.userId } : {}),
              ...(mimeHint ? { mimeHint } : {}),
            }),
            UPLOAD_TIMEOUT_MS,
          );
          rewrites.set(c.source, result);
          fileIds.push(result.fileId);
        } catch (err) {
          warn(
            `[media-upload] upload failed for source="${c.source}" tool=${event.toolName} toolCallId=${event.toolCallId}: ${(err as Error).message ?? String(err)}`,
          );
        }
      }),
    );

    if (rewrites.size === 0) return;

    const nextContent = [...rewriteContent(content ?? [], rewrites)];
    // The MEDIA: path is stripped from content (FE renders from fileRefs[]),
    // which otherwise leaves the model blind to whether delivery succeeded —
    // it then regenerates or re-delivers. A URL-free confirmation closes that
    // loop without leaking a signed URL the model would echo into prose.
    const n = rewrites.size;
    nextContent.push({
      type: "text",
      text: `[${n} file${n === 1 ? "" : "s"} delivered to the user and available for download. Do not regenerate or call deliver for ${n === 1 ? "it" : "them"} again.]`,
    });
    const nextDetails = rewriteDetails(details, rewrites, dedup(fileIds));

    return {
      result: {
        ...event.result,
        content: nextContent as OpenClawAgentToolResult["content"],
        details: nextDetails,
      },
    };
  };
}

function collectMediaCandidates(
  content: ContentItem[] | undefined,
  details: unknown,
): MediaCandidate[] {
  const seen = new Map<string, number>();
  let nextIdx = 0;

  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const src = raw.trim();
    if (!src) return;
    if (seen.has(src)) return;
    if (HTTP_URL_RE.test(src) && !MINIMAX_CDN_RE.test(src)) return;
    seen.set(src, nextIdx++);
  };

  if (details && typeof details === "object" && !Array.isArray(details)) {
    const mediaField = (details as { media?: unknown }).media;
    if (mediaField && typeof mediaField === "object" && !Array.isArray(mediaField)) {
      const media = mediaField as DetailsMedia;
      add(media.mediaUrl);
      if (Array.isArray(media.mediaUrls)) {
        for (const u of media.mediaUrls) add(u);
      }
    }
    // `deliver` tool results carry user-facing files here. Same upload/rewrite
    // path as media: signed URL → details.media.mediaUrls (channels) +
    // details.nabuFileIds (web fileRefs).
    const deliverables = (details as { deliverables?: unknown }).deliverables;
    if (Array.isArray(deliverables)) {
      for (const d of deliverables) {
        if (d && typeof d === "object") add((d as { path?: unknown }).path);
      }
    }
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as ContentItem;
      if (b.type === "text" && typeof (b as TextContent).text === "string") {
        const parsed = splitMediaFromOutput((b as TextContent).text);
        if (parsed.mediaUrls) for (const u of parsed.mediaUrls) add(u);
      }
    }
  }

  return Array.from(seen.entries()).map(([source, index]) => ({ source, index }));
}

function rewriteContent(
  content: ContentItem[],
  rewrites: Map<string, MediaUploadResult>,
): ContentItem[] {
  if (!Array.isArray(content) || content.length === 0) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type !== "text") return block;
    const text = (block as TextContent).text;
    if (typeof text !== "string" || text.length === 0) return block;
    // Strip MEDIA: markers; do not inline signedUrl into prose (FE renders
    // from fileRefs[] / details.media.mediaUrls, and the LLM echoes inlined
    // URLs back as duplicate image links).
    const parsed = splitMediaFromOutput(text);
    let rewritten = parsed.text;
    for (const [source, upload] of rewrites) {
      if (rewritten.includes(source)) {
        rewritten = rewritten.split(source).join(upload.signedUrl);
      }
    }
    return { ...(block as TextContent), text: rewritten };
  });
}

function rewriteDetails(
  details: unknown,
  rewrites: Map<string, MediaUploadResult>,
  fileIds: number[],
): unknown {
  const base =
    details && typeof details === "object" && !Array.isArray(details)
      ? { ...(details as Record<string, unknown>) }
      : {};
  const mediaField = (base as { media?: unknown }).media;
  if (mediaField && typeof mediaField === "object" && !Array.isArray(mediaField)) {
    const media = { ...(mediaField as DetailsMedia) };
    if (typeof media.mediaUrl === "string") {
      const rewrite = rewrites.get(media.mediaUrl.trim());
      if (rewrite) media.mediaUrl = rewrite.signedUrl;
    }
    if (Array.isArray(media.mediaUrls)) {
      media.mediaUrls = media.mediaUrls.map((u) =>
        typeof u === "string" ? (rewrites.get(u.trim())?.signedUrl ?? u) : u,
      );
    }
    (base as { media?: unknown }).media = media;
  } else {
    const signedUrls = Array.from(rewrites.values()).map((r) => r.signedUrl);
    if (signedUrls.length > 0) (base as { media?: unknown }).media = { mediaUrls: signedUrls };
  }
  const existingIds = Array.isArray((base as { nabuFileIds?: unknown }).nabuFileIds)
    ? ((base as { nabuFileIds: unknown[] }).nabuFileIds.filter(
        (m) => typeof m === "number",
      ) as number[])
    : [];
  (base as { nabuFileIds?: unknown }).nabuFileIds = dedup([...existingIds, ...fileIds]);
  return base;
}

function dedup(arr: number[]): number[] {
  return Array.from(new Set(arr));
}

function warn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(msg);
}
