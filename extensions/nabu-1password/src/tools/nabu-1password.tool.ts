import { jsonResult, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "../../api.js";
import { getLivePluginConfig } from "../config.js";
import {
  LOG_PREFIX,
  MAIN_AGENT_ID,
  OP_OPERATIONS,
  TOOL_NAME,
} from "../nabu-1password.constants.js";
import type { Nabu1PasswordParams } from "../nabu-1password.interface.js";
import { buildOpArgv, runOp } from "../op-runner.js";
import { fetchUserOpToken } from "../token.js";

// Schema — flat object, no identity field (identity comes from trusted context)

const Nabu1PasswordSchema = Type.Object(
  {
    operation: stringEnum(OP_OPERATIONS, {
      description:
        "Read-only 1Password operation: read (resolve an op:// secret reference), item-get, item-list, vault-list.",
    }),
    reference: Type.Optional(
      Type.String({
        description: "Secret reference op://<vault>/<item>/<field>. Required for operation=read.",
      }),
    ),
    item: Type.Optional(
      Type.String({ description: "Item name or UUID. Required for operation=item-get." }),
    ),
    vault: Type.Optional(
      Type.String({ description: "Vault name or UUID to scope item-get / item-list." }),
    ),
    fields: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Optional field labels to project for item-get (e.g. ["username","password"]).',
      }),
    ),
  },
  { additionalProperties: false },
);

// Tool registration

export function createNabu1PasswordTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: TOOL_NAME,
    label: "1Password (read-only)",
    description:
      "Read the current end user's 1Password secrets: resolve op:// references and list items/vaults. " +
      "Auth is brokered per-user by the plugin; do not pass tokens or run `op signin`. " +
      "Read-only — no create/edit/delete. See the nabu-1password skill for recipes.",
    parameters: Nabu1PasswordSchema,
    async execute(_toolCallId, params) {
      const p = params as Nabu1PasswordParams;
      try {
        // Product gate the dashboard toggles, NOT a security boundary: agentId is
        // client-influenced and the tenant sandbox is off, so the backend enforces.
        const agentId = context.agentId ?? "";
        if (!getLivePluginConfig(api).allowNonMainAgents && agentId !== MAIN_AGENT_ID) {
          return jsonResult({
            error: `Agent "${agentId || "unknown"}" may not use 1Password — an admin can enable access for non-main agents.`,
          });
        }
        const rawId = context.requesterSenderId;
        if (!rawId) {
          return jsonResult({
            error: "No requester identity in tool context — 1Password access is per-user.",
          });
        }
        const userId = Number(rawId);
        if (!Number.isInteger(userId) || userId <= 0) {
          return jsonResult({
            error: `Requester is not a numeric Nabu user id: ${String(rawId).slice(0, 40)}`,
          });
        }
        const channel = context.messageChannel ?? "unknown";

        let argv: string[];
        try {
          argv = buildOpArgv(p.operation, p);
        } catch (err) {
          return jsonResult({ error: formatErrorMessage(err) });
        }

        let opToken: string;
        try {
          opToken = await fetchUserOpToken(api, { userId, channel });
        } catch (err) {
          return jsonResult({ error: formatErrorMessage(err) });
        }

        const outcome = await runOp(api, p.operation, argv, opToken, { userId, channel });
        return jsonResult(outcome);
      } catch (err) {
        api.logger.error(`${LOG_PREFIX} ${TOOL_NAME} failed: ${formatErrorMessage(err)}`);
        return jsonResult({ error: formatErrorMessage(err) });
      }
    },
  } satisfies AnyAgentTool;
}
