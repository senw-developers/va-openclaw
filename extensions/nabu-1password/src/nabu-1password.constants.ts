/** Default NestJS backend base URL inside the tenant's Docker network. */
export const DEFAULT_API_BASE_URL = "http://app:6001";

/** Default token refresh interval — 6 hours. */
export const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;

/** NestJS endpoint that returns the decrypted ops_ token to the plugin. */
export const SKILL_CALLBACK_PATH = "/api/v1/onepassword/token";

/** Environment variable `op` CLI reads for service-account auth. */
export const OP_SERVICE_ACCOUNT_TOKEN_ENV = "OP_SERVICE_ACCOUNT_TOKEN";

/** Env vars cleared before `op` runs. See src/token.ts refreshToken() for why. */
export const OP_DEFENSIVE_ENV_CLEAR = ["OP_CONNECT_HOST", "OP_CONNECT_TOKEN"] as const;

/** Log prefix for every message emitted by this plugin. */
export const LOG_PREFIX = "[nabu-1password]";

/** Gateway RPC method NestJS calls after rotation to trigger an immediate refresh. */
export const REFRESH_RPC_METHOD = "nabu.onepassword.refresh";
