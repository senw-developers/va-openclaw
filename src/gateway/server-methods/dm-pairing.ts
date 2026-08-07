/**
 * Gateway dm.pair.* RPC handlers (scope: operator.pairing) — thin wrappers over
 * src/pairing/pairing-store.ts, which owns locking, atomic writes, account-key
 * filenames, and on-disk shapes. Hand-rolled I/O here once wiped allowlists.
 */
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  PAIRING_PENDING_TTL_MS,
  rejectChannelPairingCode,
  type PairingChannel,
  type PairingRequest,
} from "../../pairing/pairing-store.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Format-only channel validation: extension channels are legal pairing targets,
 * so we deliberately never materialize the channel registry in gateway server
 * code (src/gateway/CLAUDE.md). Mirrors pairing-cli's extension passthrough.
 */
const CHANNEL_FORMAT = /^[a-z][a-z0-9_-]{0,63}$/;

type DmPairingEntry = {
  id: string;
  code: string;
  channel: PairingChannel;
  createdAt: string;
  expiresAt: string;
  meta?: Record<string, string>;
};

type ListParams = { channel: PairingChannel; accountId?: string };
type MutateParams = ListParams & { code: string };

function parseChannel(value: unknown): PairingChannel | null {
  if (typeof value !== "string") {
    return null;
  }
  const channel = value.trim().toLowerCase();
  return CHANNEL_FORMAT.test(channel) ? (channel as PairingChannel) : null;
}

function parseAccountId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseListParams(params: unknown): ListParams | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const { channel, accountId } = params as Record<string, unknown>;
  const parsed = parseChannel(channel);
  if (!parsed) {
    return null;
  }
  return { channel: parsed, accountId: parseAccountId(accountId) };
}

function parseMutateParams(params: unknown): MutateParams | null {
  const base = parseListParams(params);
  if (!base) {
    return null;
  }
  const { code } = params as Record<string, unknown>;
  if (typeof code !== "string" || !code.trim()) {
    return null;
  }
  return { ...base, code: code.trim() };
}

function toPublicEntry(request: PairingRequest, channel: PairingChannel): DmPairingEntry {
  return {
    id: request.id,
    code: request.code,
    channel,
    createdAt: request.createdAt,
    // Expiry is derived, never stored; the store prunes expired entries on read.
    expiresAt: new Date(Date.parse(request.createdAt) + PAIRING_PENDING_TTL_MS).toISOString(),
    ...(request.meta ? { meta: request.meta } : {}),
  };
}

function invalidParams(message: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message);
}

function codeNotFound(code: string, channel: string) {
  return errorShape(
    ErrorCodes.APPROVAL_NOT_FOUND,
    `No pending pairing request with code ${code} on ${channel}`,
  );
}

export const dmPairingHandlers: GatewayRequestHandlers = {
  /**
   * dm.pair.list — pending pairing requests for a channel.
   * Params: { channel: string; accountId?: string }
   * Result: { pending: DmPairingEntry[] }
   */
  "dm.pair.list": async ({ params, respond }) => {
    const parsed = parseListParams(params);
    if (!parsed) {
      respond(false, undefined, invalidParams("dm.pair.list requires { channel, accountId? }"));
      return;
    }
    const pending = await listChannelPairingRequests(parsed.channel, process.env, parsed.accountId);
    respond(true, { pending: pending.map((request) => toPublicEntry(request, parsed.channel)) });
  },

  /**
   * dm.pair.approve — approve a pending code; sender joins the channel allowlist.
   * Params: { channel: string; code: string; accountId?: string }
   * Result: { ok: true; id: string }
   */
  "dm.pair.approve": async ({ params, respond }) => {
    const parsed = parseMutateParams(params);
    if (!parsed) {
      respond(
        false,
        undefined,
        invalidParams("dm.pair.approve requires { channel, code, accountId? }"),
      );
      return;
    }
    const approved = await approveChannelPairingCode({
      channel: parsed.channel,
      code: parsed.code,
      accountId: parsed.accountId,
    });
    if (!approved) {
      respond(false, undefined, codeNotFound(parsed.code, parsed.channel));
      return;
    }
    respond(true, { ok: true, id: approved.id });
  },

  /**
   * dm.pair.reject — discard a pending code without touching the allowlist.
   * Params: { channel: string; code: string; accountId?: string }
   * Result: { ok: true; id: string }
   */
  "dm.pair.reject": async ({ params, respond }) => {
    const parsed = parseMutateParams(params);
    if (!parsed) {
      respond(
        false,
        undefined,
        invalidParams("dm.pair.reject requires { channel, code, accountId? }"),
      );
      return;
    }
    const rejected = await rejectChannelPairingCode({
      channel: parsed.channel,
      code: parsed.code,
      accountId: parsed.accountId,
    });
    if (!rejected) {
      respond(false, undefined, codeNotFound(parsed.code, parsed.channel));
      return;
    }
    respond(true, { ok: true, id: rejected.id });
  },
};
