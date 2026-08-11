import { createHash } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { OpenClawPluginApi } from "../api.js";
import { getLivePluginConfig, hasApiToken } from "./config.js";
import {
  ACCESS_TOKEN_CACHE_MAX_MS,
  ACCESS_TOKEN_CALLBACK_PATH,
  ACCESS_TOKEN_MAX_EXPIRES_IN_MS,
  ACCESS_TOKEN_REFRESH_LEEWAY_MS,
  DEFAULT_API_BASE_URL,
  LOG_PREFIX,
  NESTJS_FETCH_TIMEOUT_MS,
} from "./nabu-google-workspace.constants.js";
import type {
  CachedAccessToken,
  NabuGoogleAccessTokenRequest,
  NabuGoogleAccessTokenResponse,
  NabuGoogleWorkspaceConfig,
} from "./nabu-google-workspace.interface.js";

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** First 12 hex of sha256 — safe to log. Never log the raw access token. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Per-(orgId, channel, userId) in-memory cache
// ---------------------------------------------------------------------------

/**
 * Access tokens are scoped per end-user (the human owner of the conversation
 * — `requesterSenderId` from the gateway tool context). The cache key also
 * includes `channel` because the same userId string (e.g. a phone number)
 * can appear across channels for different humans.
 */
const tokenCache = new Map<string, CachedAccessToken>();

function cacheKey(organizationId: string, channel: string, userId: string): string {
  return `${organizationId}::${channel}::${userId}`;
}

function isFresh(entry: CachedAccessToken, currentTokenVersion: number): boolean {
  if (entry.tokenVersion !== currentTokenVersion) {
    return false;
  }
  const now = Date.now();
  const hardExpiry = entry.cachedAtMs + ACCESS_TOKEN_CACHE_MAX_MS;
  const refreshAt = entry.expiresAtMs - ACCESS_TOKEN_REFRESH_LEEWAY_MS;
  return now < refreshAt && now < hardExpiry;
}

/** Drop all cached tokens for this gateway. Called on RPC refresh + stop. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/** Drop a specific entry. Called after an explicit upstream 401 / re-consent signal. */
export function invalidateCachedToken(
  organizationId: string,
  channel: string,
  userId: string,
): void {
  tokenCache.delete(cacheKey(organizationId, channel, userId));
}

// ---------------------------------------------------------------------------
// HTTP — fetch a fresh access token from NestJS
// ---------------------------------------------------------------------------

/**
 * Pull a short-lived access token from NestJS. Two-factor auth:
 *
 *  - `x-skill-token`     — opaque per-org bearer pushed into the plugin
 *                          config via `config.patch`.
 *  - `x-organization-id` — numeric org id from docker-compose env, never
 *                          written into `openclaw.json`, so it is NOT
 *                          prompt-extractable through the agent's shell.
 *
 * NestJS resolves `(organizationId, channel, userId)` → encrypted refresh_token,
 * runs the Google refresh exchange (single-flight via Redis lock), and
 * returns the access_token + expiry + granted scopes. Refresh tokens
 * never leave the backend.
 */
async function fetchAccessToken(
  pluginConfig: NabuGoogleWorkspaceConfig,
  organizationId: string,
  request: NabuGoogleAccessTokenRequest,
): Promise<NabuGoogleAccessTokenResponse> {
  const baseUrl = pluginConfig.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const url = new URL(ACCESS_TOKEN_CALLBACK_PATH, baseUrl);
  // Both schemes supported: the base may be docker-internal, an overlay
  // hostname, or a public HTTPS endpoint. The auth factor is the skill token.
  const transport = url.protocol === "https:" ? https : http;
  const payload = JSON.stringify(request);
  const fullUrl = url.href;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
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
            const sanitized = redactApiToken(data, pluginConfig.apiToken).slice(0, 200);
            reject(new Error(`POST ${fullUrl} failed (${res.statusCode}): ${sanitized}`));
            return;
          }
          try {
            const parsed = JSON.parse(data) as Partial<NabuGoogleAccessTokenResponse>;
            if (
              typeof parsed.accessToken !== "string" ||
              parsed.accessToken.length === 0 ||
              typeof parsed.expiresAt !== "number" ||
              !Number.isFinite(parsed.expiresAt)
            ) {
              reject(new Error(`POST ${fullUrl} returned invalid payload`));
              return;
            }
            resolve({
              accessToken: parsed.accessToken,
              expiresAt: parsed.expiresAt,
              scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
              tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : "Bearer",
            });
          } catch (err) {
            reject(new Error(`POST ${fullUrl}: bad JSON: ${(err as Error).message}`));
          }
        });
      },
    );
    req.setTimeout(NESTJS_FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`POST ${fullUrl} timed out after ${NESTJS_FETCH_TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => reject(new Error(`POST ${fullUrl} network error: ${err.message}`)));
    req.write(payload);
    req.end();
  });
}

/** Redact the bearer header value if it ever echoes back in an error body. */
function redactApiToken(text: string, apiToken: string): string {
  if (!apiToken) return text;
  return text.split(apiToken).join("[REDACTED_API_TOKEN]");
}

// ---------------------------------------------------------------------------
// Public — resolve a Bearer access token for a specific end user
// ---------------------------------------------------------------------------

/**
 * Resolve the current Bearer access token for `(organizationId, channel, userId)`.
 *
 * - Hits the in-memory cache first.
 * - Falls back to a fresh fetch from NestJS when the cache entry is stale,
 *   missing, or invalidated by a `tokenVersion` bump.
 * - Sanity-clamps `expiresAt` against absurd upstream values.
 * - Throws when the plugin isn't configured or the user has no Google
 *   connection on the backend (NestJS returns 4xx).
 */
export async function getAccessTokenForUser(
  api: OpenClawPluginApi,
  organizationId: string,
  channel: string,
  userId: string,
): Promise<string> {
  const cfg = getLivePluginConfig(api);
  if (!hasApiToken(cfg)) {
    throw new Error("nabu-google-workspace plugin is not configured (apiToken missing)");
  }
  const tokenVersion = cfg.tokenVersion ?? 0;

  const key = cacheKey(organizationId, channel, userId);
  const cached = tokenCache.get(key);
  if (cached && isFresh(cached, tokenVersion)) {
    return cached.accessToken;
  }

  const startedAt = Date.now();
  const fetched = await fetchAccessToken(cfg, organizationId, { userId, channel });

  // Sanity-clamp upstream-claimed expiry. Reject absurd values; cap to our
  // hard ceiling. Below-now values become a one-shot non-cached use.
  const expiresAtMs = fetched.expiresAt * 1000;
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs > ACCESS_TOKEN_MAX_EXPIRES_IN_MS) {
    api.logger.warn(
      `${LOG_PREFIX} backend returned implausibly distant expiresAt (${remainingMs}ms); not caching`,
    );
    return fetched.accessToken;
  }
  if (remainingMs < ACCESS_TOKEN_REFRESH_LEEWAY_MS) {
    api.logger.warn(
      `${LOG_PREFIX} backend returned near-expired access token (${remainingMs}ms); using once, not caching`,
    );
    return fetched.accessToken;
  }

  tokenCache.set(key, {
    accessToken: fetched.accessToken,
    expiresAtMs,
    scopes: fetched.scopes,
    cachedAtMs: Date.now(),
    tokenVersion,
  });
  api.logger.info(
    `${LOG_PREFIX} access token fetched (fingerprint=${fingerprint(fetched.accessToken)}, expires_in=${Math.max(0, Math.round(remainingMs / 1000))}s, scopes=${fetched.scopes.length}, latency_ms=${Date.now() - startedAt})`,
  );
  return fetched.accessToken;
}

/**
 * Lightweight startup status log. Confirms the plugin can READ its config
 * (apiToken + apiBaseUrl) and that `OPENCLAW_ORGANIZATION_ID` is set. Does
 * not perform an HTTP probe — backend health is verified lazily on the
 * first real `nabu_google` call. Logs only — never throws.
 */
export function logBackendStatus(api: OpenClawPluginApi): void {
  const organizationId = process.env.OPENCLAW_ORGANIZATION_ID;
  if (!organizationId) {
    api.logger.warn(`${LOG_PREFIX} OPENCLAW_ORGANIZATION_ID not set; tool calls will fail`);
    return;
  }
  const cfg = getLivePluginConfig(api);
  if (!hasApiToken(cfg)) {
    api.logger.warn(`${LOG_PREFIX} apiToken not configured; tool calls will fail`);
    return;
  }
  api.logger.info(
    `${LOG_PREFIX} configured (apiBaseUrl=${cfg.apiBaseUrl}, tokenVersion=${cfg.tokenVersion ?? 0})`,
  );
}
