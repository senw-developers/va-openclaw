import { hasApiToken } from "./config.js";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOG_PREFIX,
  SKILL_TOKEN_PATH,
} from "./nabu-files.constants.js";
import type { FilesApiErrorEnvelope, NabuFilesConfig } from "./nabu-files.interface.js";
import { resolveOrgSource } from "./org.js";

// Shared secret proving this is the legit free-tier container to the broker.
// Actor auth only — tenant isolation is carried by the per-org token it mints.
export const BROKER_TOKEN_ENV = "NABU_FREE_TIER_BROKER_TOKEN";

// Refetch this far before expiry so a token never expires mid-request.
const REFRESH_MARGIN_MS = 60_000;

type CachedToken = { readonly token: string; readonly expiresAtMs: number };
const brokerCache = new Map<string, CachedToken>();

function brokerTokenFromEnv(): string {
  return process.env[BROKER_TOKEN_ENV]?.trim() ?? "";
}

export function hasBrokerToken(): boolean {
  return brokerTokenFromEnv().length > 0;
}

/**
 * Files-api can serve a request when either a config token (dedicated tenant) or
 * the shared-instance broker token is present. Gates plugin registration.
 */
export function canServeFilesApi(cfg: NabuFilesConfig): boolean {
  return hasApiToken(cfg) || hasBrokerToken();
}

/**
 * The (organizationId, skillToken) pair for a call: the config token on a
 * dedicated tenant, else a per-org token brokered for the shared instance.
 * Fail-closed on a missing credential on either path.
 */
export async function resolveTenantAuth(
  cfg: NabuFilesConfig,
  agentId: string | undefined,
): Promise<{ organizationId: string; skillToken: string }> {
  const source = resolveOrgSource(agentId);
  if (source.kind === "dedicated") {
    if (!hasApiToken(cfg)) {
      throw new Error(`${LOG_PREFIX} apiToken not configured`);
    }
    return { organizationId: source.organizationId, skillToken: cfg.apiToken };
  }
  return {
    organizationId: source.organizationId,
    skillToken: await getBrokeredSkillToken(cfg, source.organizationId),
  };
}

async function getBrokeredSkillToken(
  cfg: NabuFilesConfig,
  organizationId: string,
): Promise<string> {
  const cached = brokerCache.get(organizationId);
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const minted = await mintBrokerToken(cfg, organizationId);
  brokerCache.set(organizationId, minted);
  return minted.token;
}

async function mintBrokerToken(cfg: NabuFilesConfig, organizationId: string): Promise<CachedToken> {
  const brokerToken = brokerTokenFromEnv();
  if (!brokerToken) {
    throw new Error(
      `${LOG_PREFIX} ${BROKER_TOKEN_ENV} not set; cannot broker a per-org token on a shared instance`,
    );
  }
  const url = new URL(SKILL_TOKEN_PATH, cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${brokerToken}`,
      },
      body: JSON.stringify({ organizationId: Number(organizationId) }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`${LOG_PREFIX} skill-token broker network error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let envelope: FilesApiErrorEnvelope | string = text;
    try {
      envelope = JSON.parse(text) as FilesApiErrorEnvelope;
    } catch {
      /* keep raw text */
    }
    throw new Error(
      // Envelope in the message: {code,message} is the only diagnostic for a
      // 401 (bad broker token) vs 403 (org not shared-served / suspended).
      `${LOG_PREFIX} skill-token broker returned ${res.status}: ${JSON.stringify(envelope).slice(0, 300)}`,
    );
  }

  let parsed: { token?: unknown; expiresAt?: unknown };
  try {
    parsed = JSON.parse(text) as { token?: unknown; expiresAt?: unknown };
  } catch (err) {
    throw new Error(`${LOG_PREFIX} skill-token broker: bad JSON: ${(err as Error).message}`);
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error(`${LOG_PREFIX} skill-token broker: response missing token`);
  }
  const expiresAtMs =
    typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : Number.NaN;
  // No usable expiry → cache as already-stale so the next call re-mints.
  return { token: parsed.token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 };
}

export function __resetBrokerCacheForTests(): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error("__resetBrokerCacheForTests is only available in test environments");
  }
  brokerCache.clear();
}
