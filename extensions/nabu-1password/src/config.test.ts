import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { getLivePluginConfig, hasApiToken } from "./config.js";

function apiWithConfig(apiToken: unknown): OpenClawPluginApi {
  return {
    runtime: {
      config: {
        current: () => ({
          plugins: { entries: { "nabu-1password": { config: { apiToken } } } },
        }),
      },
    },
  } as unknown as OpenClawPluginApi;
}

describe("getLivePluginConfig apiToken resolution", () => {
  afterEach(() => {
    delete process.env.NABU_ONE_PASSWORD_SKILL_TOKEN;
  });

  it("passes a resolved string token through", () => {
    const cfg = getLivePluginConfig(apiWithConfig("tok-literal"));
    expect(cfg.apiToken).toBe("tok-literal");
    expect(hasApiToken(cfg)).toBe(true);
  });

  it("does NOT resolve SecretRefs itself — core owns that, even with the env var set", () => {
    process.env.NABU_ONE_PASSWORD_SKILL_TOKEN = "tok-from-env";
    const cfg = getLivePluginConfig(
      apiWithConfig({ source: "env", provider: "default", id: "NABU_ONE_PASSWORD_SKILL_TOKEN" }),
    );
    expect(cfg.apiToken).toBe("");
    expect(hasApiToken(cfg)).toBe(false);
  });

  it("yields an empty token for malformed ref objects", () => {
    const cfg = getLivePluginConfig(apiWithConfig({ source: "vault", id: "nope" }));
    expect(cfg.apiToken).toBe("");
    expect(hasApiToken(cfg)).toBe(false);
  });
});

describe("allowNonMainAgents gate", () => {
  function apiWithFlag(allowNonMainAgents: unknown): OpenClawPluginApi {
    return {
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: { "nabu-1password": { config: { apiToken: "t", allowNonMainAgents } } },
            },
          }),
        },
      },
    } as unknown as OpenClawPluginApi;
  }

  it("defaults to false when the key is absent — only main may use the plugin", () => {
    expect(getLivePluginConfig(apiWithConfig("t")).allowNonMainAgents).toBe(false);
  });

  it("is true only for the boolean true, never a truthy string", () => {
    expect(getLivePluginConfig(apiWithFlag(true)).allowNonMainAgents).toBe(true);
    expect(getLivePluginConfig(apiWithFlag("true")).allowNonMainAgents).toBe(false);
    expect(getLivePluginConfig(apiWithFlag(1)).allowNonMainAgents).toBe(false);
  });
});
