/**
 * Plugin config shape — mirrors plugins.entries.nabu-google-workspace.config
 * in openclaw.json. Pushed by the Nabu NestJS backend via config.patch
 * over WebSocket RPC.
 */
export interface NabuGoogleWorkspaceConfig {
  /** Opaque per-org bearer issued by the GoogleWorkspace module on Nabu backend. */
  apiToken: string;
  /** NestJS backend base URL — Docker-internal (default: http://app:6001). */
  apiBaseUrl?: string;
  /** Monotonic counter; bumped server-side on rotate / re-consent / disconnect. */
  tokenVersion?: number;
  /** How often to re-validate the apiToken health with NestJS. Default 6h. */
  refreshIntervalMs?: number;
}

/**
 * Request body the plugin POSTs to the access-token endpoint.
 * `userId` is the trusted requesterSenderId from the gateway — NestJS
 * resolves `(orgId, channel, userId)` to a per-user Google connection row.
 * `channel` is the trusted gateway-side channel id (telegram, slack, web,
 * whatsapp, etc.) — necessary because the same `userId` string can appear
 * in two different channels for two different humans.
 */
export interface NabuGoogleAccessTokenRequest {
  userId: string;
  channel?: string;
}

/** Response shape of POST /api/v1/google-workspace/access-token. */
export interface NabuGoogleAccessTokenResponse {
  accessToken: string;
  /** Unix-seconds absolute timestamp. */
  expiresAt: number;
  scopes: string[];
  tokenType: string;
}

/** In-memory cache entry for one user's access token. */
export interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  scopes: string[];
  cachedAtMs: number;
  tokenVersion: number;
}
