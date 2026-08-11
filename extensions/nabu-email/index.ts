import * as http from "node:http";
import * as https from "node:https";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

/**
 * Mirrors plugins.entries.nabu-email.config.
 */
interface NabuEmailConfig {
  apiToken: string;
  apiBaseUrl?: string;
}

/**
 * Live config per call: current() returns the runtime snapshot that gateway
 * config.patch refreshes — the token-rotation path NestJS uses (T8). Direct
 * file edits do NOT propagate; rotation must ride config.patch.
 */
function getLivePluginConfig(api: OpenClawPluginApi): NabuEmailConfig {
  const cfg = api.runtime.config.current();
  const pluginEntry = (cfg as any)?.plugins?.entries?.["nabu-email"]?.config;
  return {
    /**
     * Core resolves the manifest's secretInputs SecretRef before runtime sees it,
     * on startup and on every config.patch. A non-string means resolution did not
     * run (plugin disabled), so fail closed rather than send "[object Object]".
     */
    apiToken: typeof pluginEntry?.apiToken === "string" ? pluginEntry.apiToken : "",
    apiBaseUrl: pluginEntry?.apiBaseUrl ?? "http://app:6001",
  };
}

/**
 * Composed tenancy (G1): the org header is always sent. A missing env var
 * degrades to an empty header rather than throwing — it is a provisioning
 * defect, and a per-request throw would take email down at rebuild.
 */
function resolveOrganizationId(api: OpenClawPluginApi): string {
  const organizationId = process.env.OPENCLAW_ORGANIZATION_ID?.trim();
  if (!organizationId) {
    api.logger.warn("nabu-email: OPENCLAW_ORGANIZATION_ID not set; sends are unscoped");
    return "";
  }
  return organizationId;
}

/**
 * POST to the backend SMTP API. node:http/https rather than fetch — the
 * global undici proxy dispatcher breaks plugin outbound TLS.
 */
async function apiPost(
  api: OpenClawPluginApi,
  pluginConfig: NabuEmailConfig,
  path: string,
  body: unknown,
): Promise<string> {
  const baseUrl = pluginConfig.apiBaseUrl ?? "http://app:6001";
  const url = new URL(`/api/v1/smtp/${path}`, baseUrl);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-skill-token": pluginConfig.apiToken,
          "x-organization-id": resolveOrganizationId(api),
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

/**
 * Plugin entry. Docs: https://docs.openclaw.ai/plugins/building-plugins
 */
export default definePluginEntry({
  id: "nabu-email",
  name: "@va-team/nabu-email",
  description: "Send and fetch emails via the VA.Team backend API",

  register(api: OpenClawPluginApi) {
    // Send email — per-agent. `agentId` from trusted context, never tool args
    // (confused-deputy). Contract: SPEC.md D16.
    api.registerTool(
      (context) => ({
        name: "nabu_email_send",
        label: "Send Email",
        description:
          "Send email from the organization's configured mailbox. Do NOT pass any sender/from/user/identity fields — the server resolves the mailbox itself.",
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
          const { agentId } = context;
          if (!agentId) {
            const msg = "nabu-email/send: no trusted agent identity; refusing.";
            return { content: [{ type: "text", text: msg }], details: { error: msg } };
          }
          const cfg = getLivePluginConfig(api);
          const raw = await apiPost(api, cfg, "send", { ...(params as object), agentId });
          return { content: [{ type: "text", text: raw }], details: parseJsonSafe(raw) };
        },
      }),
      { name: "nabu_email_send", optional: true },
    );

    // Fetch email — per-agent. Same identity model as send.
    api.registerTool(
      (context) => ({
        name: "nabu_email_fetch",
        label: "Fetch Emails",
        description:
          "Fetch email from the organization's configured mailbox (IMAP). Do NOT pass any user/identity fields — the server resolves the mailbox itself.",
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
          const { agentId } = context;
          if (!agentId) {
            const msg = "nabu-email/fetch: no trusted agent identity; refusing.";
            return { content: [{ type: "text", text: msg }], details: { error: msg } };
          }
          const cfg = getLivePluginConfig(api);
          const raw = await apiPost(api, cfg, "fetch", { ...(params as object), agentId });
          return { content: [{ type: "text", text: raw }], details: parseJsonSafe(raw) };
        },
      }),
      { name: "nabu_email_fetch", optional: true },
    );

    // Gateway RPC — optional receipt probe for a token push. No backend caller
    // exists today; the token is read live per call from the runtime config
    // snapshot, so config.patch alone is sufficient and needs no restart.
    api.registerGatewayMethod("nabu.email.configure", ({ respond }) => {
      respond(true, { ok: true, plugin: api.id });
    });
  },
});
