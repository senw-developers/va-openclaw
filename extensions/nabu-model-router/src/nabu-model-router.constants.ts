import type { Tier } from "./nabu-model-router.interface.js";

export const ESCALATION: Record<Tier, Tier> = {
  simple: "medium",
  medium: "hard",
  hard: "hard",
};

export const CLASSIFIER_SYSTEM_PROMPT = `You are a request complexity classifier for a chat assistant. Read the user's message and decide the minimum model tier needed to answer it well.

Tiers:
- simple: greetings, acknowledgments, single-fact lookups, short confirmations, yes/no answers, thanks, small talk
- medium: multi-step tasks, code edits under ~50 lines, short summaries, reasoning over short context, common how-to questions
- hard: long-context reasoning, multi-file refactors, complex planning, math proofs, anything requiring careful multi-step thought

Return ONLY valid minified JSON, no prose, no code fences:
{"complexity":"simple"|"medium"|"hard","confidence":"low"|"med"|"high"}`;

export const DEFAULT_ROUTER_CONFIG = {
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
} as const;
