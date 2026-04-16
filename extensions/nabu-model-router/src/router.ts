import { parseModelRef } from "./config.js";
import { ESCALATION } from "./nabu-model-router.constants.js";
import type { Classification, ModelRef, RouterConfig } from "./nabu-model-router.interface.js";

export function selectModel(c: Classification, cfg: RouterConfig): ModelRef | null {
  const tier =
    cfg.escalateOnLowConfidence && c.confidence === "low" ? ESCALATION[c.complexity] : c.complexity;
  return parseModelRef(cfg.tiers[tier]);
}
