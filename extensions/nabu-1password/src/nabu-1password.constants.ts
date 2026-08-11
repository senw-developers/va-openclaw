/** Default NestJS backend base URL inside the tenant's Docker network. */
export const DEFAULT_API_BASE_URL = "http://app:6001";

/**
 * Backend endpoint that vends the organization's 1Password service-account
 * token. Org-scoped by decision (2026-08-11) — identity comes from the
 * skill token plus `x-organization-id`, not the request body.
 */
export const ACCESS_TOKEN_PATH = "/api/v1/onepassword/token";

/** Timeout for the access-token broker call to NestJS. */
export const NESTJS_FETCH_TIMEOUT_MS = 10 * 1000;

/** Timeout for a single `op` CLI invocation. */
export const OP_EXEC_TIMEOUT_MS = 30 * 1000;

/** Hard cap on captured `op` stdout/stderr per call. */
export const OP_MAX_OUTPUT_BYTES = 256 * 1024;

/** Read-only operations the tool exposes. No create / edit / delete / rotate. */
export const OP_OPERATIONS = ["read", "item-get", "item-list", "vault-list"] as const;

/** Native 1Password CLI binary (baked into the image, on PATH). */
export const OP_BINARY = "op";

/** 1Password CLI env var that carries the service-account token. */
export const OP_TOKEN_ENV_VAR = "OP_SERVICE_ACCOUNT_TOKEN";

/** 1Password CLI env var that toggles its on-disk secret cache. */
export const OP_CACHE_ENV_VAR = "OP_CACHE";

/** Value that disables the `op` on-disk cache (keeps the user's secret off disk). */
export const OP_CACHE_DISABLED = "false";

/** Minimal PATH for the `op` child when the gateway PATH is unset. */
export const DEFAULT_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

/** Minimal HOME for the `op` child when the gateway HOME is unset. */
export const DEFAULT_CHILD_HOME = "/home/node";

/** Prefix every valid 1Password service-account token carries. */
export const OPS_TOKEN_PREFIX = "ops_";

/** Placeholder substituted for the brokered op token in any captured output. */
export const REDACTED_OP_TOKEN = "[REDACTED]";

/** Placeholder substituted for the skill-token if it echoes back in an error body. */
export const REDACTED_SKILL_TOKEN = "[REDACTED_SKILL_TOKEN]";

/** Log prefix for every message emitted by this plugin. */
export const LOG_PREFIX = "[nabu-1password]";

/** Tool name the agent calls. */
export const TOOL_NAME = "nabu_1password";

/** Plugin id — keep aligned with openclaw.plugin.json:id. */
export const PLUGIN_ID = "nabu-1password";
