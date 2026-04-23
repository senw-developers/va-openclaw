/**
 * Plugin config shape — mirrors plugins.entries.nabu-1password.config
 * in openclaw.json. Pushed by the Nabu NestJS backend via config.patch
 * over WebSocket RPC.
 */
export interface NabuOnePasswordConfig {
  /** Opaque per-org bearer issued by the OnePassword module on Nabu backend. */
  apiToken: string;
  /** NestJS backend base URL — Docker-internal (default: http://app:6001). */
  apiBaseUrl?: string;
  /** How often to re-pull the ops_ token from NestJS. Default 6h. */
  refreshIntervalMs?: number;
}

/** Response shape of POST /api/v1/onepassword/token on the Nabu backend. */
export interface NabuOnePasswordTokenResponse {
  token: string;
}
