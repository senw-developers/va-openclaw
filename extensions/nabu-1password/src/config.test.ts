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

  it("passes a literal string token through", () => {
    const cfg = getLivePluginConfig(apiWithConfig("tok-literal"));
    expect(cfg.apiToken).toBe("tok-literal");
    expect(hasApiToken(cfg)).toBe(true);
  });

  it("resolves an env SecretRef (seed shape) from the environment", () => {
    process.env.NABU_ONE_PASSWORD_SKILL_TOKEN = " tok-from-env ";
    const cfg = getLivePluginConfig(
      apiWithConfig({ source: "env", provider: "default", id: "NABU_ONE_PASSWORD_SKILL_TOKEN" }),
    );
    expect(cfg.apiToken).toBe("tok-from-env");
    expect(hasApiToken(cfg)).toBe(true);
  });

  it("yields an empty token when the SecretRef env var is unset", () => {
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
