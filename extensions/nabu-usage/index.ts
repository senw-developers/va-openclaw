import * as http from "http";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// ---------------------------------------------------------------------------
// Plugin config — mirrors plugins.entries.nabu-usage.config
// ---------------------------------------------------------------------------
interface NabuUsageConfig {
  apiBaseUrl: string;
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
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
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

// ---------------------------------------------------------------------------
// Read live config from disk on every call (same pattern as nabu-email).
//
// api.pluginConfig is a startup snapshot and won't reflect runtime
// config.patch updates. api.runtime.config.loadConfig() re-reads the
// file so apiBaseUrl changes take effect without a gateway restart.
// ---------------------------------------------------------------------------
function getLivePluginConfig(api: OpenClawPluginApi): NabuUsageConfig {
  const cfg = api.runtime.config.loadConfig();
  const pluginEntry = (cfg as any)?.plugins?.entries?.["nabu-usage"]?.config;
  return {
    apiBaseUrl: pluginEntry?.apiBaseUrl ?? "http://app:6000",
  };
}

// ---------------------------------------------------------------------------
// Fire-and-forget POST to NestJS over Docker network.
//
// Uses Node http (not fetch) for zero-dependency compat, matching
// the nabu-email plugin pattern. Response is drained but not awaited
// so the hook never blocks the agent loop.
// ---------------------------------------------------------------------------
function postUsageEvent(cfg: NabuUsageConfig, body: Record<string, unknown>): void {
  const url = new URL("/api/v1/nabu/usage/ingest", cfg.apiBaseUrl);
  const payload = JSON.stringify(body);

  const req = http.request(
    {
      hostname: url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 5_000,
    },
    (res) => {
      // Drain the response body to free the socket.
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        console.error(`[nabu-usage] POST /usage/ingest returned ${res.statusCode}`);
      }
    },
  );

  req.on("error", (err) => {
    console.error(`[nabu-usage] POST /usage/ingest error: ${err.message}`);
  });

  req.on("timeout", () => {
    req.destroy();
    console.error("[nabu-usage] POST /usage/ingest timed out");
  });

  req.write(payload);
  req.end();
}

// ---------------------------------------------------------------------------
// Plugin entry
// Docs: https://docs.openclaw.ai/plugins/building-plugins
// ---------------------------------------------------------------------------
export default definePluginEntry({
  id: "nabu-usage",
  name: "@va-team/nabu-usage",
  description:
    "Forward LLM usage events to the VA.Team backend for Cloudflare AI Gateway cost tracking",

  register(api: OpenClawPluginApi) {
    const organizationId = process.env.OPENCLAW_ORGANIZATION_ID ?? null;
    const environment = process.env.NABU_ENVIRONMENT ?? "development";

    if (!organizationId) {
      console.warn(
        "[nabu-usage] OPENCLAW_ORGANIZATION_ID not set — usage events will be missing organizationId",
      );
    }

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
      // Skip if no runId — can't correlate with Cloudflare log
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
        // Pass OpenClaw-side usage as fallback if Cloudflare log is unavailable
        usage: event.usage ?? null,
      });
    });
  },
});
