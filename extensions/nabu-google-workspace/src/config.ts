import type { OpenClawPluginApi } from "../api.js";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REFRESH_MS,
  PLUGIN_ID,
} from "./nabu-google-workspace.constants.js";
import type { NabuGoogleWorkspaceConfig } from "./nabu-google-workspace.interface.js";

interface OpenClawConfigShape {
  plugins?: {
    entries?: Record<
      string,
      {
        config?: {
          apiToken?: unknown;
          apiBaseUrl?: string;
          tokenVersion?: unknown;
          refreshIntervalMs?: unknown;
        };
      }
    >;
  };
}

/**
 * Live config per call: current() returns the runtime snapshot that gateway
 * config.patch refreshes — the token-rotation path (T8). Direct file edits
 * do NOT propagate; rotation must ride config.patch.
 */
export function getLivePluginConfig(api: OpenClawPluginApi): NabuGoogleWorkspaceConfig {
  const cfg = api.runtime.config.current() as OpenClawConfigShape;
  const entry = cfg.plugins?.entries?.[PLUGIN_ID]?.config;
  return {
    /**
     * Core resolves the manifest's secretInputs SecretRef before runtime sees it,
     * on startup and on every config.patch. A non-string means resolution did not
     * run (plugin disabled), so fail closed rather than send "[object Object]".
     */
    apiToken: typeof entry?.apiToken === "string" ? entry.apiToken : "",
    apiBaseUrl: entry?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    tokenVersion: typeof entry?.tokenVersion === "number" ? entry.tokenVersion : 0,
    refreshIntervalMs:
      typeof entry?.refreshIntervalMs === "number" ? entry.refreshIntervalMs : DEFAULT_REFRESH_MS,
  };
}

/**
 * Returns true when the plugin has a bearer token configured to call NestJS.
 */
export function hasApiToken(config: NabuGoogleWorkspaceConfig): boolean {
  return typeof config.apiToken === "string" && config.apiToken.length > 0;
}
