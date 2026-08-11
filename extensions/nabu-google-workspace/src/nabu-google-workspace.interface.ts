/**
 * Plugin config shape — mirrors plugins.entries.nabu-google-workspace.config
 * in openclaw.json. Pushed by the Nabu NestJS backend via config.patch
 * over WebSocket RPC.
 */
export interface NabuGoogleWorkspaceConfig {
  /**
   * Opaque per-org bearer issued by the GoogleWorkspace module on Nabu backend.
   */
  apiToken: string;
  /**
   * Product gate the dashboard toggles: when false (default) only agent `main`
   * may use this plugin. NOT a security boundary — the backend enforces.
   */
  allowNonMainAgents: boolean;
  /**
   * NestJS backend base URL — Docker-internal (default: http://app:6001).
   */
  apiBaseUrl?: string;
  /**
   * Monotonic counter; bumped server-side on rotate / re-consent / disconnect.
   */
  tokenVersion?: number;
  /**
   * How often to re-validate the apiToken health with NestJS. Default 6h.
   */
  refreshIntervalMs?: number;
}

/**
 * Body POSTed to the access-token endpoint. Both fields are trusted
 * gateway-side values; the backend resolves `(orgId, channel, userId)` to a
 * per-user connection row. `channel` disambiguates a reused `userId` string.
 */
export interface NabuGoogleAccessTokenRequest {
  userId: string;
  channel?: string;
}

/**
 * Response shape of POST /api/v1/google-workspace/access-token.
 */
export interface NabuGoogleAccessTokenResponse {
  accessToken: string;
  /**
   * Unix-seconds absolute timestamp.
   */
  expiresAt: number;
  scopes: string[];
  tokenType: string;
}

/**
 * In-memory cache entry for one user's access token.
 */
export interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  scopes: string[];
  cachedAtMs: number;
  tokenVersion: number;
}
