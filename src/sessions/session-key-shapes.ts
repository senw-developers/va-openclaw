// D22 shape vocabularies for parseSessionOwner — kept here so new shapes only
// require touching this file.

export const DM_MARKERS = new Set(["direct", "dm"]);

export const HTTP_USER_PREFIXES = new Set(["openresponses-user", "openai-user"]);

// Tail sentinels fail-closed against verbatim-header attacks (see SPEC.md D22).
export const TAIL_FAIL_CLOSED_TOKENS = new Set([
  "subagent",
  "cron",
  "acp",
  "group",
  "channel",
  "direct",
  "dm",
  "openresponses",
  "openai",
  "openresponses-user",
  "openai-user",
  "thread",
]);

// 0=per-peer, 1=per-channel-peer, 2=per-account-channel-peer.
export const MAX_DM_MARKER_POSITION = 2;

// Bound any recursive ':thread:' chain (defensive).
export const MAX_THREAD_STRIPS = 8;
