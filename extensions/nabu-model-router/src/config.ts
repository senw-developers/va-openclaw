import type { OpenClawConfig } from "../api.js";
import { DEFAULT_ROUTER_CONFIG } from "./nabu-model-router.constants.js";
import type { ModelRef, RouterConfig, RouterTransport } from "./nabu-model-router.interface.js";

/**
 * Parse "provider/model" into { provider, model }; null when malformed.
 */
export function parseModelRef(ref: string): ModelRef | null {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

/**
 * The set of providers managed by this router's tier config.
 */
export function getManagedProviders(cfg: RouterConfig): Set<string> {
  const providers = new Set<string>();
  for (const ref of Object.values(cfg.tiers)) {
    const parsed = parseModelRef(ref);
    if (parsed) providers.add(parsed.provider);
  }
  return providers;
}

/**
 * Schema defaults only populate top-level keys that already exist — ajv does
 * not synthesize missing nested objects — so `classifier` and `tiers` are
 * undefined when a config block is absent. Fill every field here.
 */
export function resolveRouterConfig(raw: unknown): RouterConfig {
  const r = (raw ?? {}) as Partial<RouterConfig>;
  const d = DEFAULT_ROUTER_CONFIG;
  return {
    providerId: r.providerId ?? d.providerId,
    classifier: {
      model: r.classifier?.model ?? d.classifier.model,
      timeoutMs: r.classifier?.timeoutMs ?? d.classifier.timeoutMs,
      maxTokens: r.classifier?.maxTokens ?? d.classifier.maxTokens,
      apiKeyEnvVar: r.classifier?.apiKeyEnvVar ?? d.classifier.apiKeyEnvVar,
    },
    tiers: {
      simple: r.tiers?.simple ?? d.tiers.simple,
      medium: r.tiers?.medium ?? d.tiers.medium,
      hard: r.tiers?.hard ?? d.tiers.hard,
    },
    escalateOnLowConfidence: r.escalateOnLowConfidence ?? d.escalateOnLowConfidence,
  };
}

export function resolveRouterTransport(
  cfg: OpenClawConfig | undefined,
  routerCfg: RouterConfig,
  env: NodeJS.ProcessEnv = process.env,
): RouterTransport | null {
  const provider = cfg?.models?.providers?.[routerCfg.providerId];
  const baseUrl = provider?.baseUrl?.trim();
  const apiKey = env[routerCfg.classifier.apiKeyEnvVar]?.trim();
  if (!baseUrl || !apiKey) return null;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(provider?.headers ?? {})) {
    if (typeof value === "string") {
      headers[name] = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, n) => env[n] ?? "");
    }
  }
  return { baseUrl, headers, apiKey };
}
