import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// ---------------------------------------------------------------------------
// Plugin config shape — mirrors plugins.entries.nabu-email.config in openclaw.json
// ---------------------------------------------------------------------------
interface NabuEmailConfig {
  apiToken: string;
  apiBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Internal helper — POST to the NestJS SMTP API over the Docker network.
// Reads pluginConfig at call time (not at register time) so that a
// config.patch pushed from NestJS over WebSocket is reflected immediately
// on the next tool call without a gateway restart.
// ---------------------------------------------------------------------------
async function apiPost(
  pluginConfig: NabuEmailConfig,
  path: string,
  body: unknown,
): Promise<string> {
  const baseUrl = pluginConfig.apiBaseUrl ?? "http://app:6000";

  const res = await fetch(`${baseUrl}/api/v1/smtp/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-skill-token": pluginConfig.apiToken,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`nabu-email /${path} failed (${res.status}): ${text}`);
  }

  return res.text();
}

// ---------------------------------------------------------------------------
// Plugin entry point
// Docs: https://docs.openclaw.ai/plugins/building-plugins
// ---------------------------------------------------------------------------
export default definePluginEntry({
  id: "nabu-email",
  name: "NABU Email",
  description: "Send and fetch emails via the VA.Team backend API",

  register(api: OpenClawPluginApi) {
    // -----------------------------------------------------------------------
    // Tool: send email
    //
    // optional: true — side effects + requires credentials.
    // Users opt in via: agents.list[].tools.allow: ["nabu_email_send"]
    // -----------------------------------------------------------------------
    api.registerTool(
      {
        name: "nabu_email_send",
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
          // api.pluginConfig = plugins.entries.nabu-email.config (live snapshot)
          const cfg = api.pluginConfig as NabuEmailConfig;
          const result = await apiPost(cfg, "send", params);
          return { content: [{ type: "text", text: result }] };
        },
      },
      { optional: true },
    );

    // -----------------------------------------------------------------------
    // Tool: fetch emails
    //
    // optional: true — requires credentials.
    // Users opt in via: agents.list[].tools.allow: ["nabu_email_fetch"]
    // -----------------------------------------------------------------------
    api.registerTool(
      {
        name: "nabu_email_fetch",
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
          const cfg = api.pluginConfig as NabuEmailConfig;
          const result = await apiPost(cfg, "fetch", params);
          return { content: [{ type: "text", text: result }] };
        },
      },
      { optional: true },
    );

    // -----------------------------------------------------------------------
    // Gateway RPC method — called by NestJS after pushing the token via
    // config.patch over the existing operator WebSocket connection.
    // Acts as a typed confirmation endpoint; actual persistence is done
    // by config.patch (which writes into plugins.entries.nabu-email.config).
    //
    // NestJS call:
    //   connection.rpc("nabu.email.configure", {})
    // -----------------------------------------------------------------------
    api.registerGatewayMethod("nabu.email.configure", ({ respond }) => {
      respond(true, { ok: true, plugin: api.id });
    });
  },
});
