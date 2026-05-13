import { coerceSecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { OpenClawPluginApi } from "../api.js";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PLUGIN_ID,
} from "./nabu-files.constants.js";
import type { NabuFilesConfig } from "./nabu-files.interface.js";

// Read config on every call so rotated tokens take effect without restart.
export function getLivePluginConfig(api: OpenClawPluginApi): NabuFilesConfig {
  const cfg = api.runtime.config.loadConfig();
  const entry = (cfg as any)?.plugins?.entries?.[PLUGIN_ID]?.config;
  return {
    apiToken: resolveApiTokenInput(entry?.apiToken),
    apiBaseUrl: entry?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    requestTimeoutMs: entry?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries: entry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    maxConcurrentUploads: entry?.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS,
  };
}

export function hasApiToken(config: NabuFilesConfig): boolean {
  return typeof config.apiToken === "string" && config.apiToken.length > 0;
}

function resolveApiTokenInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const ref = coerceSecretRef(value);
  if (!ref) {
    return "";
  }
  if (ref.source === "env") {
    return process.env[ref.id]?.trim() ?? "";
  }
  return "";
}
