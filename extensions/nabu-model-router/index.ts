import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { runClassifier } from "./src/classifier.js";
import { getManagedProviders, resolveRouterConfig, resolveRouterTransport } from "./src/config.js";
import type { RouterTransport } from "./src/nabu-model-router.interface.js";
import { selectModel } from "./src/router.js";

export default definePluginEntry({
  id: "nabu-model-router",
  name: "Nabu Model Router",
  description:
    "Haiku-orchestrated router that classifies each prompt and dispatches to Haiku, Sonnet, or Opus.",
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") return;

    const cfg = resolveRouterConfig(api.pluginConfig);
    const managedProviders = getManagedProviders(cfg);

    // Read the configured default model to decide if the router should be active.
    // If the default model's provider isn't in our tier list (e.g. openai-codex),
    // bypass the router entirely — let that model work its normal flow.
    const defaultModelRef =
      (api.config as { agents?: { defaults?: { model?: { primary?: string } } } })?.agents?.defaults
        ?.model?.primary ?? "";
    const defaultProvider = defaultModelRef.includes("/")
      ? defaultModelRef.slice(0, defaultModelRef.indexOf("/"))
      : "";

    if (defaultProvider && !managedProviders.has(defaultProvider)) {
      api.logger.info?.(
        `nabu-model-router: default model "${defaultModelRef}" is not managed by the router; bypassing`,
      );
      return;
    }

    let transport: RouterTransport | null | undefined;
    let transportLogged = false;

    api.on("before_model_resolve", async (event) => {
      const prompt = typeof event.prompt === "string" ? event.prompt.trim() : "";
      if (!prompt) return undefined;

      if (transport === undefined) {
        transport = resolveRouterTransport(api.config, cfg);
        if (transport && !transportLogged) {
          transportLogged = true;
          api.logger.info?.(
            `nabu-model-router: transport ready (classifier=${cfg.classifier.model}, tiers=${cfg.tiers.simple}/${cfg.tiers.medium}/${cfg.tiers.hard})`,
          );
        }
      }

      if (!transport) {
        if (!transportLogged) {
          transportLogged = true;
          api.logger.warn?.(
            `nabu-model-router: transport not available (provider="${cfg.providerId}", env=${cfg.classifier.apiKeyEnvVar}); falling through`,
          );
        }
        return undefined;
      }

      const t0 = Date.now();
      const classification = await runClassifier(prompt, cfg, transport, { logger: api.logger });
      const elapsed = Date.now() - t0;

      if (!classification) {
        api.logger.warn?.(`nabu-model-router: classifier failed (${elapsed}ms); falling through`);
        return undefined;
      }

      const selected = selectModel(classification, cfg);
      if (!selected) {
        api.logger.warn?.(`nabu-model-router: bad tier ref in config; falling through`);
        return undefined;
      }

      api.logger.info?.(
        `nabu-model-router: ${classification.complexity}/${classification.confidence} -> ${selected.provider}/${selected.model} (${elapsed}ms)`,
      );
      return { modelOverride: selected.model, providerOverride: selected.provider };
    });
  },
});
