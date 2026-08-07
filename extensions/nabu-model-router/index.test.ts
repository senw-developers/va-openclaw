import { EventEmitter } from "node:events";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import register from "./index.js";
import { getManagedProviders, parseModelRef, resolveRouterTransport } from "./src/config.js";
import { CLASSIFIER_SYSTEM_PROMPT } from "./src/nabu-model-router.constants.js";
import type { RouterConfig } from "./src/nabu-model-router.interface.js";
import { selectModel } from "./src/router.js";

const PROVIDER_BASE_URL = "https://gateway.ai.cloudflare.com/v1/acct/openclaw/anthropic";

const baseConfig = {
  models: {
    providers: {
      "cloudflare-ai-gateway": {
        baseUrl: PROVIDER_BASE_URL,
        api: "anthropic-messages" as const,
        headers: {},
        models: [],
      },
    },
  },
  agents: { defaults: { model: { primary: "cloudflare-ai-gateway/claude-sonnet-4-5" } } },
};

const pluginConfig: RouterConfig = {
  providerId: "cloudflare-ai-gateway",
  classifier: {
    model: "claude-haiku-4-5",
    timeoutMs: 5000,
    maxTokens: 64,
    apiKeyEnvVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
  },
  tiers: {
    simple: "cloudflare-ai-gateway/claude-haiku-4-5",
    medium: "cloudflare-ai-gateway/claude-sonnet-4-5",
    hard: "cloudflare-ai-gateway/claude-opus-4-6",
  },
  escalateOnLowConfidence: true,
};

function buildApi(overrides: { registrationMode?: string; config?: unknown } = {}) {
  const hooks: Record<string, Function> = {};
  const api = {
    pluginConfig,
    config: overrides.config ?? baseConfig,
    id: "nabu-model-router",
    name: "Nabu Model Router",
    registrationMode: overrides.registrationMode ?? "full",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
  };
  return { api, hooks };
}

function mockHttpsResponse(responseBody: string, statusCode = 200) {
  const res = new EventEmitter();
  Object.assign(res, { statusCode });
  const req = new EventEmitter();
  Object.assign(req, {
    setTimeout: vi.fn(),
    write: vi.fn(),
    end: vi.fn(() => {
      process.nextTick(() => {
        (req as EventEmitter).emit("response", res);
        res.emit("data", responseBody);
        res.emit("end");
      });
    }),
    destroy: vi.fn(),
  });
  vi.spyOn(https, "request").mockImplementation(((..._args: unknown[]) => {
    const cb = _args.find((a) => typeof a === "function") as
      | ((...args: unknown[]) => void)
      | undefined;
    if (cb) (req as EventEmitter).on("response", cb);
    return req as unknown as ReturnType<typeof https.request>;
  }) as unknown as typeof https.request);
}

function mockHttpsError(errorMessage: string) {
  const req = new EventEmitter();
  Object.assign(req, {
    setTimeout: vi.fn(),
    write: vi.fn(),
    end: vi.fn(() => {
      process.nextTick(() => req.emit("error", new Error(errorMessage)));
    }),
    destroy: vi.fn(),
  });
  vi.spyOn(https, "request").mockImplementation(((..._args: unknown[]) => {
    return req as unknown as ReturnType<typeof https.request>;
  }) as unknown as typeof https.request);
}

function classifierJson(complexity: string, confidence: string): string {
  return JSON.stringify({
    content: [
      { type: "text", text: `{"complexity":"${complexity}","confidence":"${confidence}"}` },
    ],
  });
}

describe("parseModelRef", () => {
  it("parses provider/model", () => {
    expect(parseModelRef("cloudflare-ai-gateway/claude-haiku-4-5")).toEqual({
      provider: "cloudflare-ai-gateway",
      model: "claude-haiku-4-5",
    });
  });

  it("returns null for bare model id", () => {
    expect(parseModelRef("claude-haiku-4-5")).toBeNull();
  });
});

describe("getManagedProviders", () => {
  it("extracts unique providers from tier refs", () => {
    expect(getManagedProviders(pluginConfig)).toEqual(new Set(["cloudflare-ai-gateway"]));
  });
});

describe("resolveRouterTransport", () => {
  it("returns null when provider is missing", () => {
    expect(
      resolveRouterTransport({ models: { providers: {} } }, pluginConfig, { ANY: "k" }),
    ).toBeNull();
  });

  it("returns null when API key env var is unset", () => {
    expect(resolveRouterTransport(baseConfig, pluginConfig, {})).toBeNull();
  });
});

describe("selectModel", () => {
  it.each([
    ["simple", "high", "cloudflare-ai-gateway", "claude-haiku-4-5"],
    ["medium", "high", "cloudflare-ai-gateway", "claude-sonnet-4-5"],
    ["hard", "high", "cloudflare-ai-gateway", "claude-opus-4-6"],
    ["simple", "low", "cloudflare-ai-gateway", "claude-sonnet-4-5"],
    ["medium", "low", "cloudflare-ai-gateway", "claude-opus-4-6"],
    ["hard", "low", "cloudflare-ai-gateway", "claude-opus-4-6"],
  ] as const)("%s/%s -> %s/%s", (complexity, confidence, expectedProvider, expectedModel) => {
    const result = selectModel({ complexity, confidence }, pluginConfig);
    expect(result).toEqual({ provider: expectedProvider, model: expectedModel });
  });

  it("does not escalate when escalateOnLowConfidence is false", () => {
    const result = selectModel(
      { complexity: "simple", confidence: "low" },
      { ...pluginConfig, escalateOnLowConfidence: false },
    );
    expect(result).toEqual({ provider: "cloudflare-ai-gateway", model: "claude-haiku-4-5" });
  });
});

describe("classifier system prompt stability", () => {
  it("is byte-stable across imports (snapshot)", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatchSnapshot();
  });
});

describe("nabu-model-router hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "sk-test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  });

  it("registers hook when default model provider is managed", () => {
    const { api } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(api.on).toHaveBeenCalledExactlyOnceWith("before_model_resolve", expect.any(Function));
  });

  it("bypasses when default model provider is not managed", () => {
    const { api } = buildApi({
      config: {
        ...baseConfig,
        agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
      },
    });
    register.register(api as unknown as OpenClawPluginApi);
    expect(api.on).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("not managed by the router"),
    );
  });

  it("routes simple prompt to Haiku", async () => {
    mockHttpsResponse(classifierJson("simple", "high"));
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(await hooks.before_model_resolve({ prompt: "hi" }, {})).toEqual({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "cloudflare-ai-gateway",
    });
  });

  it("routes hard prompt to Opus", async () => {
    mockHttpsResponse(classifierJson("hard", "high"));
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(await hooks.before_model_resolve({ prompt: "refactor 500 lines" }, {})).toEqual({
      modelOverride: "claude-opus-4-6",
      providerOverride: "cloudflare-ai-gateway",
    });
  });

  it("escalates simple+low to Sonnet", async () => {
    mockHttpsResponse(classifierJson("simple", "low"));
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(await hooks.before_model_resolve({ prompt: "maybe?" }, {})).toEqual({
      modelOverride: "claude-sonnet-4-5",
      providerOverride: "cloudflare-ai-gateway",
    });
  });

  it("returns undefined on malformed JSON", async () => {
    mockHttpsResponse(JSON.stringify({ content: [{ type: "text", text: "not json" }] }));
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(await hooks.before_model_resolve({ prompt: "x" }, {})).toBeUndefined();
  });

  it("returns undefined on HTTP error", async () => {
    mockHttpsResponse('{"error":"bad"}', 502);
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(await hooks.before_model_resolve({ prompt: "x" }, {})).toBeUndefined();
  });

  it("returns undefined on network error", async () => {
    mockHttpsError("ECONNREFUSED");
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(await hooks.before_model_resolve({ prompt: "x" }, {})).toBeUndefined();
  });

  it("skips classifier for empty prompts", async () => {
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    expect(await hooks.before_model_resolve({ prompt: "   " }, {})).toBeUndefined();
  });

  it("returns undefined when transport is unavailable at hook-fire time", async () => {
    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    const result = await hooks.before_model_resolve({ prompt: "hi" }, {});
    expect(result).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("transport not available"),
    );
  });

  it("logs transport ready only once across multiple hook fires", async () => {
    mockHttpsResponse(classifierJson("simple", "high"));
    const { api, hooks } = buildApi();
    register.register(api as unknown as OpenClawPluginApi);
    await hooks.before_model_resolve({ prompt: "hi" }, {});

    vi.restoreAllMocks();
    mockHttpsResponse(classifierJson("simple", "high"));
    await hooks.before_model_resolve({ prompt: "hello" }, {});

    const infoCalls = vi.mocked(api.logger.info).mock.calls.map((c) => c[0]);
    const transportReadyCalls = infoCalls.filter(
      (m) => typeof m === "string" && m.includes("transport ready"),
    );
    expect(transportReadyCalls).toHaveLength(1);
  });

  it("silently skips registration in non-full modes", () => {
    const { api } = buildApi({ registrationMode: "cli-metadata" });
    register.register(api as unknown as OpenClawPluginApi);
    expect(api.on).not.toHaveBeenCalled();
  });
});
