import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { describe, expect, it } from "vitest";
import {
  findUnresolvedHeaderPlaceholders,
  registerNabuGatewayDoctorChecks,
} from "./org-header-placeholder-check.js";

function cfgWithHeader(value: string): OpenClawConfig {
  return {
    models: {
      providers: {
        "cloudflare-ai-gateway": {
          headers: { "cf-aig-metadata": value },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("findUnresolvedHeaderPlaceholders", () => {
  it("flags an unset placeholder embedded in a header value", () => {
    const findings = findUnresolvedHeaderPlaceholders(
      cfgWithHeader('{"organizationId":"${OPENCLAW_ORGANIZATION_ID}"}'),
      {},
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.path).toBe(
      "models.providers.cloudflare-ai-gateway.headers.cf-aig-metadata",
    );
    expect(findings[0]?.target).toBe("OPENCLAW_ORGANIZATION_ID");
  });

  it("passes when the referenced env var is set", () => {
    const findings = findUnresolvedHeaderPlaceholders(
      cfgWithHeader('{"organizationId":"${OPENCLAW_ORGANIZATION_ID}"}'),
      { OPENCLAW_ORGANIZATION_ID: "42" },
    );
    expect(findings).toEqual([]);
  });

  it("treats an empty/whitespace env var as unset — it would still ship literally", () => {
    expect(findUnresolvedHeaderPlaceholders(cfgWithHeader("${ORG}"), { ORG: "   " })).toHaveLength(
      1,
    );
  });

  it("passes on a fully literal header value", () => {
    expect(findUnresolvedHeaderPlaceholders(cfgWithHeader("static-value"), {})).toEqual([]);
  });

  it("checks request.headers as well as headers", () => {
    const cfg = {
      models: {
        providers: {
          openai: { request: { headers: { "x-org": "${MISSING_ORG}" } } },
        },
      },
    } as unknown as OpenClawConfig;
    const findings = findUnresolvedHeaderPlaceholders(cfg, {});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("models.providers.openai.request.headers.x-org");
  });

  it("returns nothing when there are no providers", () => {
    expect(findUnresolvedHeaderPlaceholders({} as OpenClawConfig, {})).toEqual([]);
  });
});

describe("registerNabuGatewayDoctorChecks", () => {
  it("registers the org-header check once, even if called twice", () => {
    const registered: HealthCheck[] = [];
    const host = { registerHealthCheck: (check: HealthCheck) => registered.push(check) };
    registerNabuGatewayDoctorChecks(host);
    registerNabuGatewayDoctorChecks(host);
    expect(registered.map((c) => c.id)).toEqual(["nabu-gateway/org-header-placeholder"]);
    expect(registered[0]?.kind).toBe("plugin");
  });
});
