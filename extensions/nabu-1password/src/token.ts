import * as http from "http";
import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "../api.js";
import { getLivePluginConfig, hasApiToken } from "./config.js";
import {
  DEFAULT_API_BASE_URL,
  LOG_PREFIX,
  OP_DEFENSIVE_ENV_CLEAR,
  OP_SERVICE_ACCOUNT_TOKEN_ENV,
  SKILL_CALLBACK_PATH,
} from "./nabu-1password.constants.js";
import type {
  NabuOnePasswordConfig,
  NabuOnePasswordTokenResponse,
} from "./nabu-1password.interface.js";

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** First 12 hex of sha256 — safe to log. Never log the raw token. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// HTTP — fetch the decrypted ops_ token from NestJS
// ---------------------------------------------------------------------------

/**
 * Pull the raw `ops_` service-account token from NestJS. Two-factor auth:
 *
 *  - `x-skill-token`     — opaque per-org bearer pushed into the plugin
 *                          config via `config.patch`. Leaked config alone
 *                          is not usable without the second factor below.
 *  - `x-organization-id` — numeric org id from docker-compose env, never
 *                          written into `openclaw.json`, so it is NOT
 *                          prompt-extractable through the agent's shell.
 *
 * Both headers must match the same DB row. Missing or mismatched → 401.
 */
export async function fetchOpsToken(
  pluginConfig: NabuOnePasswordConfig,
  organizationId: string,
): Promise<string> {
  const baseUrl = pluginConfig.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const url = new URL(SKILL_CALLBACK_PATH, baseUrl);
  const payload = "{}";
  const fullUrl = url.href;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 80,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-skill-token": pluginConfig.apiToken,
          "x-organization-id": organizationId,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`POST ${fullUrl} failed (${res.statusCode})`));
            return;
          }
          try {
            const parsed = JSON.parse(data) as Partial<NabuOnePasswordTokenResponse>;
            if (!parsed.token || !parsed.token.startsWith("ops_")) {
              reject(new Error(`POST ${fullUrl} returned invalid payload`));
              return;
            }
            resolve(parsed.token);
          } catch (err) {
            reject(new Error(`POST ${fullUrl}: bad JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error(`POST ${fullUrl} network error: ${err.message}`)));
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Refresh — keep process.env in sync with the tenant's current token
// ---------------------------------------------------------------------------

/**
 * Refresh `process.env.OP_SERVICE_ACCOUNT_TOKEN` from NestJS.
 *
 * Defensive env hygiene is applied on every successful refresh:
 *  - `OP_CACHE=false` — the CLI's local cache writes to `$HOME` and is
 *    uninteresting for our flow. Keeping it off avoids stale cached creds.
 *  - `OP_CONNECT_HOST` / `OP_CONNECT_TOKEN` are cleared. 1Password gives
 *    those precedence over `OP_SERVICE_ACCOUNT_TOKEN` when both are set,
 *    so stray Connect vars would silently flip the auth mode.
 *
 * Failures are logged, never thrown. A bad or missing token surfaces to
 * the agent as a 1Password auth error from `op`, not a plugin crash.
 */
export async function refreshToken(api: OpenClawPluginApi): Promise<void> {
  const organizationId = process.env.OPENCLAW_ORGANIZATION_ID;
  if (!organizationId) {
    api.logger.warn(`${LOG_PREFIX} OPENCLAW_ORGANIZATION_ID not set; skipping`);
    return;
  }

  const cfg = getLivePluginConfig(api);
  if (!hasApiToken(cfg)) {
    api.logger.warn(`${LOG_PREFIX} apiToken not configured; skipping`);
    return;
  }

  try {
    const token = await fetchOpsToken(cfg, organizationId);
    process.env[OP_SERVICE_ACCOUNT_TOKEN_ENV] = token;
    process.env.OP_CACHE = "false";
    for (const key of OP_DEFENSIVE_ENV_CLEAR) {
      delete process.env[key];
    }
    api.logger.info(`${LOG_PREFIX} token refreshed (fingerprint=${fingerprint(token)})`);
  } catch (err) {
    api.logger.error(
      `${LOG_PREFIX} token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Clear the gateway's cached service-account token from `process.env`. */
export function clearToken(): void {
  delete process.env[OP_SERVICE_ACCOUNT_TOKEN_ENV];
}
