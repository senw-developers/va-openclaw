import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROKER_TOKEN_ENV,
  __resetBrokerCacheForTests,
  canServeFilesApi,
  resolveTenantAuth,
} from "./broker.js";
import type { NabuFilesConfig } from "./nabu-files.interface.js";

const ORG_KEY = "OPENCLAW_ORGANIZATION_ID";
const cfg: NabuFilesConfig = {
  apiToken: "cfg-token",
  apiBaseUrl: "http://app:6001",
  requestTimeoutMs: 5000,
};

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("resolveTenantAuth + broker", () => {
  let origOrg: string | undefined;
  let origBroker: string | undefined;

  beforeEach(() => {
    origOrg = process.env[ORG_KEY];
    origBroker = process.env[BROKER_TOKEN_ENV];
    delete process.env[ORG_KEY];
    delete process.env[BROKER_TOKEN_ENV];
    __resetBrokerCacheForTests();
  });

  afterEach(() => {
    if (origOrg === undefined) delete process.env[ORG_KEY];
    else process.env[ORG_KEY] = origOrg;
    if (origBroker === undefined) delete process.env[BROKER_TOKEN_ENV];
    else process.env[BROKER_TOKEN_ENV] = origBroker;
    vi.unstubAllGlobals();
  });

  it("dedicated tenant uses the config token and never calls the broker", async () => {
    process.env[ORG_KEY] = "7";
    const fetchFn = stubFetch({});
    const auth = await resolveTenantAuth(cfg, "main");
    expect(auth).toEqual({ organizationId: "7", skillToken: "cfg-token" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("shared instance brokers a per-org token, sending Bearer + numeric org", async () => {
    process.env[BROKER_TOKEN_ENV] = "broker-secret";
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const fetchFn = stubFetch({ token: "org42-token", expiresAt });
    const auth = await resolveTenantAuth(cfg, "agent-org-42");
    expect(auth).toEqual({ organizationId: "42", skillToken: "org42-token" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/files-api/skill-token");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer broker-secret");
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: 42 });
  });

  it("caches the brokered token within its TTL", async () => {
    process.env[BROKER_TOKEN_ENV] = "broker-secret";
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const fetchFn = stubFetch({ token: "org42-token", expiresAt });
    await resolveTenantAuth(cfg, "agent-org-42");
    await resolveTenantAuth(cfg, "agent-org-42");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-mints when the cached token is within the refresh margin of expiry", async () => {
    process.env[BROKER_TOKEN_ENV] = "broker-secret";
    // 30s out — inside the 60s refresh margin, so the second call must re-mint.
    const soon = new Date(Date.now() + 30_000).toISOString();
    const fetchFn = stubFetch({ token: "org42-token", expiresAt: soon });
    await resolveTenantAuth(cfg, "agent-org-42");
    await resolveTenantAuth(cfg, "agent-org-42");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("fails closed on the shared path when the broker token env is unset", async () => {
    await expect(resolveTenantAuth(cfg, "agent-org-42")).rejects.toThrow(
      new RegExp(BROKER_TOKEN_ENV),
    );
  });

  it("fails closed when the broker returns a non-2xx", async () => {
    process.env[BROKER_TOKEN_ENV] = "broker-secret";
    stubFetch({ code: "FORBIDDEN", message: "org not shared-served" }, 403);
    await expect(resolveTenantAuth(cfg, "agent-org-42")).rejects.toThrow(/403/);
  });

  it("canServeFilesApi is true with a config token or a broker token, else false", () => {
    expect(canServeFilesApi(cfg)).toBe(true);
    const noToken: NabuFilesConfig = { apiToken: "", apiBaseUrl: "http://app:6001" };
    expect(canServeFilesApi(noToken)).toBe(false);
    process.env[BROKER_TOKEN_ENV] = "broker-secret";
    expect(canServeFilesApi(noToken)).toBe(true);
  });
});
