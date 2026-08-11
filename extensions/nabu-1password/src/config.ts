import type { OpenClawPluginApi } from "../api.js";
import { DEFAULT_API_BASE_URL, PLUGIN_ID } from "./nabu-1password.constants.js";
import type { Nabu1PasswordConfig } from "./nabu-1password.interface.js";

interface OpenClawConfigShape {
  plugins?: { entries?: Record<string, { config?: { apiToken?: unknown; apiBaseUrl?: string } }> };
}

/**
 * Read this plugin's config from the active runtime snapshot via
 * `api.runtime.config.current()` — the approved accessor; the deprecated
 * loader seam is blocked by the config-boundary architecture guard.
 */
export function getLivePluginConfig(api: OpenClawPluginApi): Nabu1PasswordConfig {
  const cfg = api.runtime.config.current() as unknown as OpenClawConfigShape;
  const entry = cfg.plugins?.entries?.[PLUGIN_ID]?.config;
  return {
    /**
     * Core resolves the manifest's secretInputs SecretRef before runtime sees it,
     * on startup and on every config.patch. A non-string means resolution did not
     * run (plugin disabled), so fail closed rather than send "[object Object]".
     */
    apiToken: typeof entry?.apiToken === "string" ? entry.apiToken : "",
    apiBaseUrl: entry?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
  };
}

/**
 * Returns true when the plugin has a bearer token configured to call NestJS.
 */
export function hasApiToken(config: Nabu1PasswordConfig): boolean {
  return typeof config.apiToken === "string" && config.apiToken.length > 0;
}
