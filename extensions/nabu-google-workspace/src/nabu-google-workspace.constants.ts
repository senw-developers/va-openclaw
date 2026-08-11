/**
 * Default NestJS backend base URL inside the tenant's Docker network.
 */
export const DEFAULT_API_BASE_URL = "http://app:6001";

/**
 * Default health-check / re-validate interval — 6 hours.
 */
export const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * NestJS endpoint that vends decrypted short-lived Google access tokens.
 */
export const ACCESS_TOKEN_CALLBACK_PATH = "/api/v1/google-workspace/access-token";

/**
 * Refresh access tokens this many ms before their advertised expiry.
 */
export const ACCESS_TOKEN_REFRESH_LEEWAY_MS = 120 * 1000;

/**
 * Hard upper bound on cached access-token lifetime regardless of expiresAt.
 */
export const ACCESS_TOKEN_CACHE_MAX_MS = 60 * 60 * 1000;

/**
 * Reject upstream-claimed expiry more than this far in the future.
 */
export const ACCESS_TOKEN_MAX_EXPIRES_IN_MS = 2 * 60 * 60 * 1000;

/**
 * Timeout for the access-token callback to NestJS.
 */
export const NESTJS_FETCH_TIMEOUT_MS = 10 * 1000;

/**
 * Timeout for outbound calls from the passthrough tool to Google REST APIs.
 */
export const GOOGLE_FETCH_TIMEOUT_MS = 30 * 1000;

/**
 * Google API base URL — the only host the passthrough tool will dispatch to.
 */
export const GOOGLE_API_BASE = "https://www.googleapis.com";

/**
 * Allowed path prefixes the passthrough tool will forward to. Defense-in-depth
 * alongside Google's own ACLs. Validated AFTER URL resolution to prevent
 * `..` / encoded-traversal escape from one prefix into another API surface.
 */
export const ALLOWED_PATH_PREFIXES = [
  "/drive/v3/",
  "/calendar/v3/",
  "/oauth2/v3/userinfo",
] as const;

/**
 * Allowed HTTP methods on the passthrough tool.
 */
export const ALLOWED_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/**
 * Log prefix for every message emitted by this plugin.
 */
export const LOG_PREFIX = "[nabu-google-workspace]";

/**
 * Gateway RPC method NestJS calls after rotation / re-consent to invalidate caches.
 */
export const REFRESH_RPC_METHOD = "nabu.googleworkspace.refresh";

/**
 * Tool name the agent calls to talk to Google.
 */
export const TOOL_NAME = "nabu_google";

/**
 * Plugin id — keep aligned with openclaw.plugin.json:id.
 */
export const PLUGIN_ID = "nabu-google-workspace";

/**
 * Reserved id of the organization's primary agent. Non-main agents are gated by
 * `allowNonMainAgents` — a product toggle, not a security boundary.
 */
export const MAIN_AGENT_ID = "main";
