import { coerceSecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { DEFAULT_API_BASE_URL, PLUGIN_ID } from "./nabu-1password.constants.js";
import type { Nabu1PasswordConfig } from "./nabu-1password.interface.js";

interface OpenClawConfigShape {
  plugins?: {
    entries?: Record<
      string,
      { config?: { apiToken?: unknown; apiBaseUrl?: string; allowNonMainAgents?: unknown } }
    >;
  };
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
    apiToken: resolveApiTokenInput(entry?.apiToken),
    apiBaseUrl: entry?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    allowNonMainAgents: entry?.allowNonMainAgents === true,
  };
}

/**
 * Returns true when the plugin has a bearer token configured to call NestJS.
 */
export function hasApiToken(config: Nabu1PasswordConfig): boolean {
  return typeof config.apiToken === "string" && config.apiToken.length > 0;
}

/**
 * Resolve a literal token or an env SecretRef {source, provider, id}. Kept local
 * rather than declared as a core `secretInputs` path: core resolution is FATAL,
 * so an unset env var would reject every config.patch instead of degrading to a
 * per-call 401 on this plugin alone.
 */
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
