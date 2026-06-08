import * as http from "http";
import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// ---------------------------------------------------------------------------
// Plugin config shape — mirrors plugins.entries.nabu-email.config
// ---------------------------------------------------------------------------
interface NabuEmailConfig {
  apiToken: string;
  apiBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Read plugin config from the live config file on every tool call.
//
// api.pluginConfig is captured at registration time (startup snapshot), so
// it will NOT reflect changes made via config.patch after startup.
// api.runtime.config.loadConfig() reads the current file from disk,
// ensuring the token pushed by NestJS is always used without a restart.
// ---------------------------------------------------------------------------
function getLivePluginConfig(api: OpenClawPluginApi): NabuEmailConfig {
  const cfg = api.runtime.config.loadConfig();
  const pluginEntry = (cfg as any)?.plugins?.entries?.["nabu-email"]?.config;
  return {
    apiToken: pluginEntry?.apiToken ?? "",
    apiBaseUrl: pluginEntry?.apiBaseUrl ?? "http://app:6001",
  };
}

// ---------------------------------------------------------------------------
// Internal helper — POST to the NestJS SMTP API over the Docker network.
// ---------------------------------------------------------------------------
async function apiPost(
  pluginConfig: NabuEmailConfig,
  path: string,
  body: unknown,
): Promise<string> {
  const baseUrl = pluginConfig.apiBaseUrl ?? "http://app:6001";
  const url = new URL(`/api/v1/smtp/${path}`, baseUrl);

  return new Promise((resolve, reject) => {
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
          "x-skill-token": pluginConfig.apiToken,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`nabu-email /${path} failed (${res.statusCode}): ${data}`));
          } else {
            resolve(data);
          }
        });
      },
    );
    req.on("error", (err) =>
      reject(new Error(`nabu-email /${path} network error: ${err.message}`)),
    );
    req.write(payload);
    req.end();
  });
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// Docs: https://docs.openclaw.ai/plugins/building-plugins
// ---------------------------------------------------------------------------
export default definePluginEntry({
  id: "nabu-email",
  name: "@va-team/nabu-email",
  description: "Send and fetch emails via the VA.Team backend API",

  register(api: OpenClawPluginApi) {
    // -----------------------------------------------------------------------
    // Tool: send email
    //
    // optional: true — side effects + requires credentials.
    // Enable via: agents.list[main].tools.allow: ["nabu_email_send"]
    // -----------------------------------------------------------------------
    api.registerTool(
      {
        name: "nabu_email_send",
        label: "Send Email",
        description: "Send an email on behalf of the organization via the configured SMTP account.",
        parameters: Type.Object({
          to: Type.Union([
            Type.String({ description: "Single recipient address" }),
            Type.Array(Type.String(), { description: "Multiple recipients" }),
          ]),
          subject: Type.String(),
          html: Type.String({ description: "Email body as HTML" }),
          text: Type.Optional(
            Type.String({ description: "Plain-text fallback — auto-generated if omitted" }),
          ),
          replyTo: Type.Optional(Type.String({ description: "Reply-to address" })),
        }),
        async execute(_callId, params) {
          const cfg = getLivePluginConfig(api);
          const raw = await apiPost(cfg, "send", params);
          const details = parseJsonSafe(raw);
          return { content: [{ type: "text", text: raw }], details };
        },
      },
      { optional: true },
    );

    // -----------------------------------------------------------------------
    // Tool: fetch emails
    //
    // optional: true — requires credentials.
    // Enable via: agents.list[main].tools.allow: ["nabu_email_fetch"]
    // -----------------------------------------------------------------------
    api.registerTool(
      {
        name: "nabu_email_fetch",
        label: "Fetch Emails",
        description: "Fetch recent emails from the organization inbox.",
        parameters: Type.Object({
          mailbox: Type.Optional(Type.String({ default: "INBOX" })),
          limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 10 })),
          unseen: Type.Optional(
            Type.Boolean({
              default: true,
              description: "When true, fetch only unread messages",
            }),
          ),
          since: Type.Optional(
            Type.String({
              description: "ISO date string — only return messages after this date",
            }),
          ),
        }),
        async execute(_callId, params) {
          const cfg = getLivePluginConfig(api);
          const raw = await apiPost(cfg, "fetch", params);
          const details = parseJsonSafe(raw);
          return { content: [{ type: "text", text: raw }], details };
        },
      },
      { optional: true },
    );

    // -----------------------------------------------------------------------
    // Gateway RPC — NestJS calls this after config.patch to confirm receipt.
    // The actual token is read live from disk via getLivePluginConfig(),
    // so no restart is needed after a token update.
    //
    // NestJS call: connection.rpc("nabu.email.configure", {})
    // -----------------------------------------------------------------------
    api.registerGatewayMethod("nabu.email.configure", ({ respond }) => {
      respond(true, { ok: true, plugin: api.id });
    });
  },
});
