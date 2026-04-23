import type { OpenClawPluginApi } from "../api.js";
import { DEFAULT_API_BASE_URL, DEFAULT_REFRESH_MS } from "./nabu-1password.constants.js";
import type { NabuOnePasswordConfig } from "./nabu-1password.interface.js";

/**
 * Read plugin config from the live config file on every call.
 *
 * `api.pluginConfig` is a startup snapshot and will NOT reflect changes
 * made via `config.patch` after startup. `api.runtime.config.loadConfig()`
 * re-reads the file from disk so rotations pushed by NestJS take effect
 * without a gateway restart.
 */
export function getLivePluginConfig(api: OpenClawPluginApi): NabuOnePasswordConfig {
  const cfg = api.runtime.config.loadConfig();
  const entry = (cfg as any)?.plugins?.entries?.["nabu-1password"]?.config;
  return {
    apiToken: entry?.apiToken ?? "",
    apiBaseUrl: entry?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    refreshIntervalMs: entry?.refreshIntervalMs ?? DEFAULT_REFRESH_MS,
  };
}

/** Returns true when the plugin has a bearer token configured to call NestJS. */
export function hasApiToken(config: NabuOnePasswordConfig): boolean {
  return typeof config.apiToken === "string" && config.apiToken.length > 0;
}
