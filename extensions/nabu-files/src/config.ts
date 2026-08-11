import type { OpenClawPluginApi } from "../api.js";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PLUGIN_ID,
} from "./nabu-files.constants.js";
import type { NabuFilesConfig } from "./nabu-files.interface.js";

/**
 * Live config per call: current() returns the runtime snapshot that gateway
 * config.patch refreshes — the token-rotation path (T8). Direct file edits
 * do NOT propagate; rotation must ride config.patch.
 */
export function getLivePluginConfig(api: OpenClawPluginApi): NabuFilesConfig {
  const cfg = api.runtime.config.current();
  const entry = (cfg as any)?.plugins?.entries?.[PLUGIN_ID]?.config;
  return {
    /**
     * Core resolves the manifest's secretInputs SecretRef before runtime sees it,
     * on startup and on every config.patch. A non-string means resolution did not
     * run (plugin disabled), so fail closed rather than send "[object Object]".
     */
    apiToken: typeof entry?.apiToken === "string" ? entry.apiToken : "",
    apiBaseUrl: entry?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    requestTimeoutMs: entry?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries: entry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    maxConcurrentUploads: entry?.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS,
  };
}

export function hasApiToken(config: NabuFilesConfig): boolean {
  return typeof config.apiToken === "string" && config.apiToken.length > 0;
}
