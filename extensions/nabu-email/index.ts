import * as http from "http";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Plugin config shape — mirrors plugins.entries.nabu-email.config
// ---------------------------------------------------------------------------
interface NabuEmailConfig {
  apiToken: string;
  apiBaseUrl?: string;
}

// ---------------------------------------------------------------------------
/**
 * Live config per call: current() returns the runtime snapshot that gateway
 * config.patch refreshes — the token-rotation path NestJS uses (T8). Direct
 * file edits do NOT propagate; rotation must ride config.patch.
 */
function getLivePluginConfig(api: OpenClawPluginApi): NabuEmailConfig {
  const cfg = api.runtime.config.current();
  const pluginEntry = (cfg as any)?.plugins?.entries?.["nabu-email"]?.config;
  return {
    apiToken: resolveApiTokenInput(pluginEntry?.apiToken),
    apiBaseUrl: pluginEntry?.apiBaseUrl ?? "http://app:6001",
  };
}

/** Accept a literal token or an env SecretRef {source, provider, id} (nabu-files pattern). */
function resolveApiTokenInput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const ref = coerceSecretRef(value);
  if (!ref) {
    return "";
  }
  if (ref.source === "env") {
    return process.env[ref.id]?.trim() ?? "";
  }
  return "";
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
  // Composed tenancy (G1): the backend scopes agentId->user mailbox routing
  // per org (B6-3). Fail-closed so sends never route against the wrong tenant.
  const organizationId = process.env.OPENCLAW_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error("nabu-email: OPENCLAW_ORGANIZATION_ID not set");
  }

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
          "x-organization-id": organizationId,
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
    // Send email — per-agent. `agentId` from trusted context, never tool args
    // (confused-deputy). Contract: SPEC.md D16.
    api.registerTool(
      (context) => ({
        name: "nabu_email_send",
        label: "Send Email",
        description:
          "Send email from this agent's user mailbox. Server resolves sender from agentId — do NOT pass any sender/from/user/identity fields.",
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
          const raw = await apiPost(cfg, "send", { ...(params as object), agentId });
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
          "Fetch email from this agent's user mailbox (IMAP). Server resolves mailbox owner from agentId — do NOT pass any user/identity fields.",
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
          const raw = await apiPost(cfg, "fetch", { ...(params as object), agentId });
          return { content: [{ type: "text", text: raw }], details: parseJsonSafe(raw) };
        },
      }),
      { name: "nabu_email_fetch", optional: true },
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
