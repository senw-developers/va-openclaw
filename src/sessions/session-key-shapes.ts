/**
 * D22 shape vocabularies for parseSessionOwner — kept here so new shapes only
 * require touching this file.
 */

export const DM_MARKERS = new Set(["direct", "dm"]);

export const HTTP_USER_PREFIXES = new Set(["openresponses-user", "openai-user"]);

/**
 * Relay shape `api:<organizationId>:<userId>:<timestamp>`, sent verbatim by the
 * backend. userId is a fixed middle segment, so it cannot join
 * HTTP_USER_PREFIXES — those take every segment after the head as the id.
 */
export const API_RELAY_PREFIX = "api";

/**
 * Owning userId for an api-relay key's segments, or null when the shape does not
 * match. Fail-closed on a non-numeric id: only `app_users.id` is a real owner,
 * and the key is client-supplied (D-SEC-1).
 */
export function parseApiRelayUserId(restParts: string[]): string | null {
  if (restParts.length < 4) {
    return null;
  }
  const userId = restParts[2]?.trim();
  return userId && /^\d+$/.test(userId) ? userId : null;
}

/**
 * Tail sentinels fail-closed against verbatim-header attacks (see SPEC.md D22).
 */
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
  "api",
  "thread",
]);

/**
 * 0=per-peer, 1=per-channel-peer, 2=per-account-channel-peer.
 */
export const MAX_DM_MARKER_POSITION = 2;

/**
 * Bound any recursive ':thread:' chain (defensive).
 */
export const MAX_THREAD_STRIPS = 8;
