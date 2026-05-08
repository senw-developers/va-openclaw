import { promises as fs } from "node:fs";
import path from "node:path";
import { detectMime } from "../media/mime.js";

/**
 * Cap on how many bytes a single file can be base64-inlined into the
 * OpenResponses `output_text`. Larger files are skipped silently rather than
 * leaking their local path. Tune via `OPENRESPONSES_INLINE_MAX_BYTES`; default
 * 1 MB strikes a balance between covering typical generated images and not
 * bloating the agent's session log.
 */
const DEFAULT_INLINE_MAX_BYTES = 1 * 1024 * 1024;

function resolveInlineMaxBytes(): number {
  const fromEnv = process.env.OPENRESPONSES_INLINE_MAX_BYTES;
  if (!fromEnv) {
    return DEFAULT_INLINE_MAX_BYTES;
  }
  const parsed = Number.parseInt(fromEnv, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INLINE_MAX_BYTES;
}

/** Tool result shape we read mediaUrls from. Mirrors `ReplyPayload`. */
type MediaCarrierPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

/**
 * Collect every distinct media reference from a list of payloads.
 * Reads both the legacy `mediaUrl` (single) and modern `mediaUrls` (array)
 * fields on `ReplyPayload`. Order-preserving deduplication so the rendered
 * markdown matches the agent's intended sequence.
 */
export function collectMediaUrlsFromPayloads(
  payloads: ReadonlyArray<MediaCarrierPayload> | null | undefined,
): string[] {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of payloads) {
    if (typeof p?.mediaUrl === "string" && p.mediaUrl.length > 0 && !seen.has(p.mediaUrl)) {
      seen.add(p.mediaUrl);
      out.push(p.mediaUrl);
    }
    if (Array.isArray(p?.mediaUrls)) {
      for (const u of p.mediaUrls) {
        if (typeof u === "string" && u.length > 0 && !seen.has(u)) {
          seen.add(u);
          out.push(u);
        }
      }
    }
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isImageMime(mime: string | undefined): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

/**
 * Render a list of mediaUrls (paths and/or http URLs) as markdown that can be
 * appended to an OpenResponses `output_text`. Local paths are inlined as
 * `data:` URIs when small enough; http URLs pass through. The resolver returns
 * an empty string if there is nothing renderable, so callers can safely
 * concatenate without an extra branch.
 *
 * Failure modes are silent on purpose: an unreadable path or an
 * over-budget file is skipped rather than echoed back to the user as a path
 * (which would re-introduce the leak we are eliminating).
 */
export async function renderInlineMediaMarkdown(
  mediaUrls: ReadonlyArray<string>,
  opts?: { maxBytes?: number },
): Promise<string> {
  if (!mediaUrls.length) {
    return "";
  }
  const maxBytes = opts?.maxBytes ?? resolveInlineMaxBytes();
  const lines: string[] = [];

  for (const ref of mediaUrls) {
    if (isHttpUrl(ref)) {
      // Already a public URL — embed as image markdown by default; clients
      // tolerate `![](...)` for non-image URLs as a bare link.
      lines.push(`![](${ref})`);
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(ref);
    } catch {
      // Unreadable / missing — silently drop. Never echo the local path back.
      continue;
    }
    if (buffer.byteLength > maxBytes) {
      // Too big to inline. Drop silently for now; future iteration can swap
      // in a hosted-URL fallback when video is in scope.
      continue;
    }
    let mime: string | undefined;
    try {
      mime = await detectMime({ buffer, filePath: ref });
    } catch {
      mime = undefined;
    }
    const effectiveMime = mime ?? "application/octet-stream";
    const dataUri = `data:${effectiveMime};base64,${buffer.toString("base64")}`;
    if (isImageMime(effectiveMime)) {
      lines.push(`![](${dataUri})`);
    } else {
      const label = path.basename(ref) || "file";
      lines.push(`[${label}](${dataUri})`);
    }
  }

  return lines.join("\n\n");
}

/**
 * Convenience: append rendered media markdown to existing assistant text.
 * Returns the original text unchanged when there is nothing to attach so
 * callers do not need to branch.
 */
export async function appendInlineMediaToText(
  text: string,
  payloads: ReadonlyArray<MediaCarrierPayload> | null | undefined,
  opts?: { maxBytes?: number },
): Promise<string> {
  const mediaUrls = collectMediaUrlsFromPayloads(payloads);
  if (mediaUrls.length === 0) {
    return text;
  }
  const block = await renderInlineMediaMarkdown(mediaUrls, opts);
  if (!block) {
    return text;
  }
  return text ? `${text}\n\n${block}` : block;
}
