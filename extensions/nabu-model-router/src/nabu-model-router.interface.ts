export type Tier = "simple" | "medium" | "hard";
export type Confidence = "low" | "med" | "high";

export type Classification = {
  complexity: Tier;
  confidence: Confidence;
};

export type ModelRef = { provider: string; model: string };

export type RouterConfig = {
  providerId: string;
  classifier: {
    model: string;
    timeoutMs: number;
    maxTokens: number;
    apiKeyEnvVar: string;
  };
  tiers: Record<Tier, string>;
  escalateOnLowConfidence: boolean;
};

export type RouterTransport = {
  baseUrl: string;
  headers: Record<string, string>;
  apiKey: string;
};

export type ClassifierLogger = {
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};
