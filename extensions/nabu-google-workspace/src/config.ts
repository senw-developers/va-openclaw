import { coerceSecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
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
          allowNonMainAgents?: unknown;
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
    apiToken: resolveApiTokenInput(entry?.apiToken),
    apiBaseUrl: entry?.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    allowNonMainAgents: entry?.allowNonMainAgents === true,
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
