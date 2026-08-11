import https from "node:https";
import { CLASSIFIER_SYSTEM_PROMPT } from "./nabu-model-router.constants.js";
import type {
  Classification,
  ClassifierLogger,
  RouterConfig,
  RouterTransport,
} from "./nabu-model-router.interface.js";

function parseClassification(raw: unknown): Classification | null {
  if (typeof raw !== "object" || raw === null) return null;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((b) => (typeof b === "object" && b && (b as { text?: string }).text) || "")
    .join("")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(text) as { complexity?: string; confidence?: string };
    if (
      (parsed.complexity === "simple" ||
        parsed.complexity === "medium" ||
        parsed.complexity === "hard") &&
      (parsed.confidence === "low" || parsed.confidence === "med" || parsed.confidence === "high")
    ) {
      return parsed as Classification;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * node:https rather than fetch: the global undici EnvHttpProxyAgent dispatcher
 * (src/infra/net/undici-global-dispatcher.ts) yields "other side closed" on
 * outbound HTTPS to the CF AI Gateway.
 */
function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function runClassifier(
  prompt: string,
  cfg: RouterConfig,
  transport: RouterTransport,
  opts?: { logger?: ClassifierLogger },
): Promise<Classification | null> {
  const log = opts?.logger;
  const url = `${transport.baseUrl}/v1/messages`;

  log?.debug?.(
    `[classifier] POST ${url} model=${cfg.classifier.model} prompt=${prompt.length}chars`,
  );

  try {
    const body = JSON.stringify({
      model: cfg.classifier.model,
      max_tokens: cfg.classifier.maxTokens,
      system: [
        {
          type: "text",
          text: CLASSIFIER_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: prompt }],
    });

    const res = await httpsPost(
      url,
      {
        "content-type": "application/json",
        "x-api-key": transport.apiKey,
        "anthropic-version": "2023-06-01",
        ...transport.headers,
      },
      body,
      cfg.classifier.timeoutMs,
    );

    if (res.status < 200 || res.status >= 300) {
      log?.warn?.(`[classifier] HTTP ${res.status} from ${url}: ${res.data.slice(0, 500)}`);
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(res.data);
    } catch {
      log?.warn?.(`[classifier] non-JSON response: ${res.data.slice(0, 300)}`);
      return null;
    }

    log?.debug?.(`[classifier] raw response: ${res.data.slice(0, 500)}`);

    const result = parseClassification(payload);
    if (!result) {
      log?.warn?.(`[classifier] unparseable response: ${res.data.slice(0, 500)}`);
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn?.(`[classifier] error: ${msg}`);
    return null;
  }
}
