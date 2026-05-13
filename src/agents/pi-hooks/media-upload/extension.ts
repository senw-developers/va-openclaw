import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  ToolResultEventResult,
} from "@mariozechner/pi-coding-agent";

import { detectMime } from "../../../media/mime.js";
import { splitMediaFromOutput } from "../../../media/parse.js";
import { getMediaUploader, type MediaUploadResult } from "../../../plugin-sdk/media-uploader.js";
import { withTimeout } from "../../../utils/with-timeout.js";

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

// Pi tool_result handler: uploads candidate media via the registered uploader
// before the result is folded into a ToolResultMessage and persisted. No-op
// when no uploader is registered or the tool is a built-in pi tool.
export default function mediaUploadExtension(api: ExtensionAPI): void {
  api.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | void> => {
    const uploader = getMediaUploader();
    if (!uploader) return;

    if (BUILT_IN_PI_TOOLS.has(event.toolName)) return;

    const candidates = collectMediaCandidates(event);
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
              ...(mimeHint ? { mimeHint } : {}),
            }),
            UPLOAD_TIMEOUT_MS,
          );
          rewrites.set(c.source, result);
          fileIds.push(result.fileId);
        } catch (err) {
          warn(
            ctx,
            `[media-upload] upload failed for source="${c.source}" tool=${event.toolName} toolCallId=${event.toolCallId}: ${(err as Error).message ?? String(err)}`,
          );
        }
      }),
    );

    if (rewrites.size === 0) return;

    const nextContent = rewriteContent(event.content as ContentItem[], rewrites);
    const nextDetails = rewriteDetails(event.details, rewrites, dedup(fileIds));

    return {
      content: nextContent as (TextContent | ImageContent)[],
      details: nextDetails,
      isError: event.isError,
    };
  });
}

function collectMediaCandidates(event: ToolResultEvent): MediaCandidate[] {
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

  const details = event.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const mediaField = (details as { media?: unknown }).media;
    if (mediaField && typeof mediaField === "object" && !Array.isArray(mediaField)) {
      const media = mediaField as DetailsMedia;
      add(media.mediaUrl);
      if (Array.isArray(media.mediaUrls)) {
        for (const u of media.mediaUrls) add(u);
      }
    }
  }

  if (Array.isArray(event.content)) {
    for (const block of event.content) {
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

function rewriteContent(content: ContentItem[], rewrites: Map<string, MediaUploadResult>): ContentItem[] {
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
  const base = details && typeof details === "object" && !Array.isArray(details) ? { ...(details as Record<string, unknown>) } : {};
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
    ? ((base as { nabuFileIds: unknown[] }).nabuFileIds.filter((n) => typeof n === "number") as number[])
    : [];
  (base as { nabuFileIds?: unknown }).nabuFileIds = dedup([...existingIds, ...fileIds]);
  return base;
}

function dedup(arr: number[]): number[] {
  return Array.from(new Set(arr));
}

function warn(ctx: ExtensionContext, msg: string): void {
  const logger = (ctx as { logger?: { warn?: (m: string) => void } }).logger;
  if (logger?.warn) {
    logger.warn(msg);
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(msg);
}
