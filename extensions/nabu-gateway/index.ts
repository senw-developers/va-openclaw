import * as http from "node:http";
import * as https from "node:https";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// ---------------------------------------------------------------------------
// Plugin config — mirrors plugins.entries.nabu-gateway.config
// ---------------------------------------------------------------------------
interface NabuGatewayConfig {
  apiBaseUrl: string;
  apiToken: string;
}

// ---------------------------------------------------------------------------
// Event / context shapes based on OpenClaw src/plugins/types.ts
//
// llm_output event:  called from attempt.ts → hookRunner.runLlmOutput()
// Context:           PluginHookAgentContext
// ---------------------------------------------------------------------------

/** Fields passed as the first arg to the llm_output hook handler. */
interface LlmOutputEvent {
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  assistantTexts?: string[];
  lastAssistant?: unknown;
  /**
   * Mirrors core NormalizedUsage (`src/agents/usage.ts`) exactly — token counts
   * only, no cost. Forwarded verbatim, so a wrong key here would silently ship
   * `undefined` to the backend's metering.
   */
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoningTokens?: number;
    total?: number;
  };
}

/** PluginHookAgentContext — second arg to agent lifecycle hooks. */
interface AgentHookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

/**
 * Live config per call: current() returns the runtime snapshot that gateway
 * config.patch refreshes — the token-rotation/kill-switch path (T8). Direct
 * file edits do NOT propagate; rotation must ride config.patch.
 */
function getLivePluginConfig(api: OpenClawPluginApi): NabuGatewayConfig {
  const cfg = api.runtime.config.current();
  const pluginEntry = (cfg as any)?.plugins?.entries?.["nabu-gateway"]?.config;
  return {
    apiBaseUrl: pluginEntry?.apiBaseUrl ?? "http://app:6001",
    apiToken: pluginEntry?.apiToken ?? "",
  };
}

/**
 * Reads the top-level `nabuEnabled` flag from the live openclaw.json config.
 * Defaults to true so the agent runs normally if the field is missing.
 */
function isNabuEnabled(api: OpenClawPluginApi): boolean {
  const cfg = api.runtime.config.current();
  const pluginEntry = (cfg as any)?.plugins?.entries?.["nabu-gateway"]?.config;
  return pluginEntry?.enabled !== false;
}

// ---------------------------------------------------------------------------
// Fire-and-forget POST to the backend.
//
// Node http/https rather than fetch: OpenClaw installs a global undici proxy
// dispatcher that breaks plugin outbound TLS. Response is drained but not
// awaited so the hook never blocks the agent loop.
//
// ⚠ Contract obligation, not an implementation detail: this lane must NEVER
// retry. The backend keys nothing on runId and its accumulators are
// unconditional, so a retry double-bills the tenant.
// ---------------------------------------------------------------------------
function postUsageEvent(cfg: NabuGatewayConfig, body: Record<string, unknown>): void {
  const url = new URL("/api/v1/nabu/usage/ingest", cfg.apiBaseUrl);
  const payload = JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        // Sent ahead of a backend guard so the guard can ship without a
        // lockstep release; the route is unauthenticated today.
        "x-skill-token": cfg.apiToken,
      },
      timeout: 5_000,
    },
    (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        console.error(`[nabu-gateway] POST /usage/ingest returned ${res.statusCode}`);
      }
    },
  );

  req.on("error", (err) => {
    console.error(`[nabu-gateway] POST /usage/ingest error: ${err.message}`);
  });

  req.on("timeout", () => {
    req.destroy();
    console.error("[nabu-gateway] POST /usage/ingest timed out");
  });

  req.write(payload);
  req.end();
}

// ---------------------------------------------------------------------------
// Plugin entry
// Docs: https://docs.openclaw.ai/plugins/building-plugins
// ---------------------------------------------------------------------------
export default definePluginEntry({
  id: "nabu-gateway",
  name: "@va-team/nabu-gateway",
  description:
    "VA.Team gateway bridge — LLM usage tracking via Cloudflare AI Gateway and credit-based gating",

  register(api: OpenClawPluginApi) {
    const organizationId = process.env.OPENCLAW_ORGANIZATION_ID ?? null;
    const environment = process.env.NABU_ENVIRONMENT ?? "development";

    if (!organizationId) {
      console.warn(
        "[nabu-gateway] OPENCLAW_ORGANIZATION_ID not set — usage events will be missing organizationId",
      );
    }

    // -----------------------------------------------------------------
    // Hook: before_agent_reply
    //
    // Fires before the LLM call. If nabuEnabled is false in
    // openclaw.json, short-circuit with a synthetic reply —
    // zero tokens spent, channels stay connected.
    //
    // NestJS toggles this via config.patch when credits are
    // exhausted or replenished.
    // -----------------------------------------------------------------
    api.on("before_agent_reply", (_event: unknown, _ctx: AgentHookContext) => {
      if (!isNabuEnabled(api)) {
        return {
          handled: true,
          reply: {
            text: "⚠️ Your organization's AI credits have been exhausted. Please top up or wait for your billing cycle to reset.",
          },
        };
      }
      return undefined;
    });

    // -----------------------------------------------------------------
    // Hook: llm_output
    //
    // Fires after every LLM call regardless of trigger source
    // (API, cron, heartbeat, DM, subagent, etc.)
    //
    // See: src/agents/pi-embedded-runner/run/attempt.ts
    //      → hookRunner.runLlmOutput(event, ctx)
    // -----------------------------------------------------------------
    api.on("llm_output", (event: LlmOutputEvent, ctx: AgentHookContext) => {
      if (!event.runId) return;

      const cfg = getLivePluginConfig(api);

      postUsageEvent(cfg, {
        runId: event.runId,
        organizationId,
        environment,
        sessionKey: ctx.sessionKey ?? null,
        sessionId: event.sessionId ?? ctx.sessionId ?? null,
        agentId: ctx.agentId ?? null,
        provider: event.provider ?? null,
        model: event.model ?? null,
        trigger: ctx.trigger ?? null,
        channel: ctx.channelId ?? null,
        usage: event.usage ?? null,
      });
    });
  },
});
