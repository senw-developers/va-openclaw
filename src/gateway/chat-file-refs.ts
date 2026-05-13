import fs from "node:fs";
import {
  getMediaResolver,
  type FileRef,
  type MediaResolver,
} from "../plugin-sdk/media-resolver.js";

// Custom JSONL entry type: bound positionally to the most-recent preceding
// user-role message in the transcript.
export const USER_ATTACHMENT_CUSTOM_TYPE = "nabu-file-attachment";

// Walks raw JSONL. User messages do not carry details.nabuFileIds, so inbound
// uploads are surfaced via sibling custom entries attributed positionally.
export function readUserAttachmentFileIdsByMessage(filePath: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!filePath || !fs.existsSync(filePath)) return out;
  let lastUserId: string | null = null;
  try {
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const entry = parsed as {
        id?: unknown;
        type?: unknown;
        customType?: unknown;
        message?: { role?: unknown };
        data?: { fileIds?: unknown };
      };
      if (entry.message && typeof entry.message === "object" && entry.message.role === "user") {
        if (typeof entry.id === "string") lastUserId = entry.id;
        continue;
      }
      if (entry.type === "custom" && entry.customType === USER_ATTACHMENT_CUSTOM_TYPE) {
        const raw = entry.data?.fileIds;
        if (!Array.isArray(raw)) continue;
        const ids: number[] = [];
        for (const v of raw) {
          if (typeof v === "number" && Number.isFinite(v)) ids.push(v);
        }
        if (ids.length === 0 || !lastUserId) continue;
        const existing = out.get(lastUserId);
        if (existing) {
          for (const id of ids) if (!existing.includes(id)) existing.push(id);
        } else {
          out.set(lastUserId, [...ids]);
        }
      }
    }
  } catch {
    /* swallow read errors; return whatever we have */
  }
  return out;
}

// The LLM frequently emits stale/hallucinated `![alt](url)` alongside the
// real signedUrl in fileRefs[]; strip it so the FE renders from fileRefs only.
export const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;

export function stripMarkdownImages(text: string): string {
  if (!text || !text.includes("![")) return text;
  return text.replace(MARKDOWN_IMAGE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

function stripMarkdownImagesFromAssistantText(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const role = (message as { role?: unknown }).role;
  if (role !== "assistant") return message;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    if (typeof content === "string" && content.includes("![")) {
      return {
        ...(message as Record<string, unknown>),
        content: stripMarkdownImages(content),
      };
    }
    return message;
  }
  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if ((block as { type?: unknown }).type !== "text") return block;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || !text.includes("![")) return block;
    const stripped = stripMarkdownImages(text);
    if (stripped === text) return block;
    changed = true;
    return { ...(block as Record<string, unknown>), text: stripped };
  });
  if (!changed) return message;
  return { ...(message as Record<string, unknown>), content: next };
}

export async function enrichMessagesWithFileRefs(
  messages: ReadonlyArray<unknown>,
  opts?: { requestId?: string; userAttachments?: Map<string, number[]> },
): Promise<unknown[]> {
  if (messages.length === 0) return messages as unknown[];

  const resolver = getMediaResolver();
  if (!resolver) return messages as unknown[];

  const idsPerIndex: number[][] = [];
  const allIds = new Set<number>();
  let anyIds = false;
  const userAttachments = opts?.userAttachments;
  for (let i = 0; i < messages.length; i++) {
    const fromDetails = extractNabuFileIds(messages[i]);
    const fromAttachments = userAttachments ? extractUserAttachmentIds(messages[i], userAttachments) : [];
    const ids = dedupNumbers([...fromDetails, ...fromAttachments]);
    idsPerIndex[i] = ids;
    if (ids.length > 0) {
      anyIds = true;
      for (const id of ids) allIds.add(id);
    }
  }
  if (!anyIds) {
    return messages.map((m) => stripMarkdownImagesFromAssistantText(m));
  }

  const resolvedMap = await batchResolve(resolver, Array.from(allIds), opts);

  return messages.map((message, i) => {
    const stripped = stripMarkdownImagesFromAssistantText(message);
    const ids = idsPerIndex[i];
    if (!ids || ids.length === 0) return stripped;
    if (!stripped || typeof stripped !== "object") return stripped;
    const refs: FileRef[] = [];
    for (const id of ids) {
      const ref = resolvedMap.get(id);
      if (ref) refs.push(ref);
    }
    if (refs.length === 0) return stripped;
    return { ...(stripped as Record<string, unknown>), fileRefs: refs };
  });
}

export async function enrichMessageWithFileRefs(
  message: unknown,
  opts?: { requestId?: string },
): Promise<unknown> {
  const stripped = stripMarkdownImagesFromAssistantText(message);
  const ids = extractNabuFileIds(stripped);
  if (ids.length === 0) return stripped;
  const resolver = getMediaResolver();
  if (!resolver) return stripped;
  const resolvedMap = await batchResolve(resolver, ids, opts);
  const refs: FileRef[] = [];
  for (const id of ids) {
    const ref = resolvedMap.get(id);
    if (ref) refs.push(ref);
  }
  if (refs.length === 0) return stripped;
  return { ...(stripped as Record<string, unknown>), fileRefs: refs };
}

// Flat dedup'd FileRef[] for the whole list — used by per-turn surfaces like
// OpenResponses HTTP that surface a single fileRefs field on the response.
export async function gatherFileRefsForMessages(
  messages: ReadonlyArray<unknown>,
  opts?: { requestId?: string; userAttachments?: Map<string, number[]> },
): Promise<FileRef[]> {
  if (messages.length === 0 && !(opts?.userAttachments && opts.userAttachments.size > 0)) return [];
  const resolver = getMediaResolver();
  if (!resolver) return [];

  const allIds = new Set<number>();
  for (const message of messages) {
    for (const id of extractNabuFileIds(message)) allIds.add(id);
    if (opts?.userAttachments) {
      for (const id of extractUserAttachmentIds(message, opts.userAttachments)) allIds.add(id);
    }
  }
  // Include user-attachment ids whose user message isn't in this slice.
  if (opts?.userAttachments) {
    for (const ids of opts.userAttachments.values()) for (const id of ids) allIds.add(id);
  }
  if (allIds.size === 0) return [];

  const resolvedMap = await batchResolve(resolver, Array.from(allIds), opts);
  const out: FileRef[] = [];
  const seen = new Set<number>();
  for (const ref of resolvedMap.values()) {
    if (seen.has(ref.fileId)) continue;
    seen.add(ref.fileId);
    out.push(ref);
  }
  return out;
}

function extractUserAttachmentIds(message: unknown, map: Map<string, number[]>): number[] {
  if (!message || typeof message !== "object") return [];
  const role = (message as { role?: unknown }).role;
  if (role !== "user") return [];
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  if (!meta || typeof meta !== "object") return [];
  const id = (meta as { id?: unknown }).id;
  if (typeof id !== "string") return [];
  return map.get(id) ?? [];
}

function dedupNumbers(arr: number[]): number[] {
  return Array.from(new Set(arr));
}

function extractNabuFileIds(message: unknown): number[] {
  if (!message || typeof message !== "object") return [];
  const details = (message as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const raw = (details as { nabuFileIds?: unknown }).nabuFileIds;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

async function batchResolve(
  resolver: MediaResolver,
  fileIds: ReadonlyArray<number>,
  opts?: { requestId?: string },
): Promise<Map<number, FileRef>> {
  const map = new Map<number, FileRef>();
  if (fileIds.length === 0) return map;
  try {
    const refs = await resolver({
      fileIds,
      ...(opts?.requestId ? { requestId: opts.requestId } : {}),
    });
    for (const ref of refs) map.set(ref.fileId, ref);
  } catch {
    // Non-fatal: caller emits without fileRefs.
  }
  return map;
}
