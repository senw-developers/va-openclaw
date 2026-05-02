import type { OpenClawPluginApi } from "../api.js";
import {
  ALLOWED_API_BASE_URL_PATTERNS,
  DEFAULT_API_BASE_URL,
  DEFAULT_REFRESH_MS,
  PLUGIN_ID,
} from "./nabu-google-workspace.constants.js";
import type { NabuGoogleWorkspaceConfig } from "./nabu-google-workspace.interface.js";

interface OpenClawConfigShape {
  plugins?: { entries?: Record<string, { config?: NabuGoogleWorkspaceConfig }> };
}

/**
 * Read plugin config from the live config file on every call.
 *
 * `api.pluginConfig` is a startup snapshot and will NOT reflect changes
 * made via `config.patch` after startup. `api.runtime.config.loadConfig()`
 * re-reads the file from disk so rotations pushed by NestJS take effect
 * without a gateway restart.
 *
 * `apiBaseUrl` is validated against an allowlist of Docker-internal hostnames.
 * A poisoned or malicious `config.patch` cannot redirect the access-token
 * callback (and the bearer headers it carries) to an attacker-controlled host.
 */
export function getLivePluginConfig(api: OpenClawPluginApi): NabuGoogleWorkspaceConfig {
  const cfg = api.runtime.config.loadConfig() as OpenClawConfigShape;
  const entry = cfg.plugins?.entries?.[PLUGIN_ID]?.config;
  return {
    apiToken: entry?.apiToken ?? "",
    apiBaseUrl: validateApiBaseUrl(entry?.apiBaseUrl) ?? DEFAULT_API_BASE_URL,
    tokenVersion: typeof entry?.tokenVersion === "number" ? entry.tokenVersion : 0,
    refreshIntervalMs:
      typeof entry?.refreshIntervalMs === "number" ? entry.refreshIntervalMs : DEFAULT_REFRESH_MS,
  };
}

/** Returns true when the plugin has a bearer token configured to call NestJS. */
export function hasApiToken(config: NabuGoogleWorkspaceConfig): boolean {
  return typeof config.apiToken === "string" && config.apiToken.length > 0;
}

/** Returns the value if it matches the docker-internal allowlist; otherwise null. */
function validateApiBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (ALLOWED_API_BASE_URL_PATTERNS.some((pattern) => pattern.test(raw))) {
    return raw;
  }
  return null;
}
