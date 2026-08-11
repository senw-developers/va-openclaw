import { createHash } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import type { OpenClawPluginApi } from "../api.js";
import { getLivePluginConfig, hasApiToken } from "./config.js";
import {
  ACCESS_TOKEN_PATH,
  DEFAULT_API_BASE_URL,
  LOG_PREFIX,
  NESTJS_FETCH_TIMEOUT_MS,
  OPS_TOKEN_PREFIX,
  REDACTED_SKILL_TOKEN,
} from "./nabu-1password.constants.js";
import type { OpTokenRequest } from "./nabu-1password.interface.js";

/** First 12 hex of sha256 — safe to log. Never log the raw token. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Redact the skill-token value if it ever echoes back in an error body. */
export function redactSkillToken(text: string, apiToken: string): string {
  if (!apiToken) {
    return text;
  }
  return text.split(apiToken).join(REDACTED_SKILL_TOKEN);
}

/**
 * Map a non-2xx broker response to a clear, agent-actionable message.
 * 1Password is organization-scoped, so every state is about the ORG, never
 * about the individual requester — 403 is the one caller-specific case.
 */
export function mapBrokerError(status: number, body: string): string {
  const detail = describeBackendError(body);
  const suffix = detail ? ` (${detail})` : "";
  if (status === 401) {
    return "1Password broker rejected the plugin credential (check NABU_ONE_PASSWORD_SKILL_TOKEN).";
  }
  if (status === 403) {
    return `1Password is configured for this organization, but you have not been granted access — ask an organization admin to grant it.${suffix}`;
  }
  if (status === 404) {
    return `1Password is not configured for this organization — an admin can connect it in the dashboard.${suffix}`;
  }
  if (status === 410) {
    return `The organization's 1Password connection was revoked and must be reconnected in the dashboard.${suffix}`;
  }
  return `1Password broker failed (${status})${suffix}.`;
}

/**
 * Read the backend's error envelope. It emits `{error, reason?, detail?}`;
 * `{code, message}` is tolerated so a future envelope change is not a
 * regression. Returns null when the body is not JSON or carries nothing useful.
 */
function describeBackendError(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  const parts = ["code", "error", "message", "reason", "detail"]
    .map((key) => envelope[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.length > 0 ? [...new Set(parts)].join(": ") : null;
}

/** Assert the broker returned a 1Password service-account token. */
export function assertOpsToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !token.startsWith(OPS_TOKEN_PREFIX)) {
    throw new Error("1Password broker returned a non-ops_ token");
  }
}

/**
 * Fetch the per-user 1Password service-account token from NestJS.
 *
 * No caching — called on every tool invocation. The backend is authoritative
 * and sends no invalidate signal, so each call resolves the current token.
 */
export async function fetchUserOpToken(
  api: OpenClawPluginApi,
  request: OpTokenRequest,
): Promise<string> {
  const cfg = getLivePluginConfig(api);
  if (!hasApiToken(cfg)) {
    throw new Error("nabu-1password plugin is not configured (apiToken missing)");
  }
  const baseUrl = cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const url = new URL(ACCESS_TOKEN_PATH, baseUrl);
  // Both schemes are supported: the base may be a docker-internal host, an
  // overlay hostname, or a public HTTPS endpoint. The auth factor is the skill
  // token, not the transport.
  const transport = url.protocol === "https:" ? https : http;
  // Composed tenancy (G1): the broker route is org-scoped — fail-closed so
  // tokens are never vended against the wrong tenant (B7).
  const organizationId = process.env.OPENCLAW_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error(
      "nabu-1password: OPENCLAW_ORGANIZATION_ID not set; broker calls are org-scoped",
    );
  }
  const payload = JSON.stringify(request);

  const token = await new Promise<string>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-skill-token": cfg.apiToken,
          "x-organization-id": organizationId,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            const sanitized = redactSkillToken(data, cfg.apiToken).slice(0, 200);
            reject(new Error(mapBrokerError(status, sanitized)));
            return;
          }
          try {
            const parsed = JSON.parse(data) as { token?: unknown };
            assertOpsToken(parsed.token);
            resolve(parsed.token);
          } catch (err) {
            reject(new Error(`1Password broker bad response: ${(err as Error).message}`));
          }
        });
      },
    );
    req.setTimeout(NESTJS_FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`1Password broker timed out after ${NESTJS_FETCH_TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => reject(new Error(`1Password broker network error: ${err.message}`)));
    req.write(payload);
    req.end();
  });

  api.logger.info(`${LOG_PREFIX} brokered op token (fingerprint=${fingerprint(token)})`);
  return token;
}

/** Startup readiness log — confirms config is present. Logs only; never throws. */
export function logBackendStatus(api: OpenClawPluginApi): void {
  const cfg = getLivePluginConfig(api);
  if (!hasApiToken(cfg)) {
    api.logger.warn(`${LOG_PREFIX} apiToken not configured; tool calls will fail`);
    return;
  }
  api.logger.info(`${LOG_PREFIX} configured (apiBaseUrl=${cfg.apiBaseUrl})`);
}
