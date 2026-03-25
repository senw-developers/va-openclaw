import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

// ---------------------------------------------------------------------------
// Supported channels
// ---------------------------------------------------------------------------

const SUPPORTED_CHANNELS = [
  "telegram",
  "whatsapp",
  "signal",
  "imessage",
  "discord",
  "slack",
  "feishu",
] as const;

type DmPairingChannel = (typeof SUPPORTED_CHANNELS)[number];

// ---------------------------------------------------------------------------
// On-disk schema — ~/.openclaw/credentials/<channel>-pairing.json
//
// {
//   "version": 1,
//   "requests": [
//     {
//       "id": "1702326053",       ← sender's platform user ID
//       "code": "LP3FHZ45",       ← 8-char approval code
//       "createdAt": "2026-...",  ← ISO timestamp; expiry = createdAt + 1h
//       "lastSeenAt": "2026-...",
//       "meta": { "firstName": "...", "lastName": "...", "accountId": "default" }
//     }
//   ]
// }
// ---------------------------------------------------------------------------

interface PairingRequest {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, unknown>;
}

interface PairingFile {
  version: number;
  requests: PairingRequest[];
}

// Matches CLI behaviour: codes expire 1 hour after creation
const PAIRING_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// RPC response shape
// ---------------------------------------------------------------------------

interface DmPairingEntry {
  id: string;
  code: string;
  channel: DmPairingChannel;
  createdAt: string;
  expiresAt: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getStateDir(context: GatewayRequestContext): string {
  return (
    (context as unknown as { statePath?: string }).statePath ??
    process.env["OPENCLAW_STATE_DIR"] ??
    join(process.env["HOME"] ?? "/home/node", ".openclaw")
  );
}

function pairingFilePath(stateDir: string, channel: string): string {
  return join(stateDir, "credentials", `${channel}-pairing.json`);
}

function allowFromFilePath(stateDir: string, channel: string): string {
  return join(stateDir, "credentials", `${channel}-allowFrom.json`);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function readPairingFile(filePath: string): PairingFile {
  if (!existsSync(filePath)) {
    return { version: 1, requests: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as PairingFile).requests)) {
      return parsed as PairingFile;
    }
    return { version: 1, requests: [] };
  } catch {
    return { version: 1, requests: [] };
  }
}

function writePairingFile(filePath: string, file: PairingFile): void {
  writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function readAllowFrom(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function writeAllowFrom(filePath: string, ids: string[]): void {
  writeFileSync(filePath, JSON.stringify(ids, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidChannel(channel: unknown): channel is DmPairingChannel {
  return typeof channel === "string" && (SUPPORTED_CHANNELS as readonly string[]).includes(channel);
}

function isExpired(req: PairingRequest): boolean {
  return Date.now() > new Date(req.createdAt).getTime() + PAIRING_TTL_MS;
}

function toPublicEntry(req: PairingRequest, channel: DmPairingChannel): DmPairingEntry {
  return {
    id: req.id,
    code: req.code,
    channel,
    createdAt: req.createdAt,
    expiresAt: new Date(new Date(req.createdAt).getTime() + PAIRING_TTL_MS).toISOString(),
    meta: req.meta,
  };
}

// ---------------------------------------------------------------------------
// Param validation
// ---------------------------------------------------------------------------

function validateListParams(params: unknown): { channel: DmPairingChannel } | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const { channel } = params as Record<string, unknown>;
  if (!isValidChannel(channel)) {
    return null;
  }
  return { channel };
}

function validateMutateParams(params: unknown): { channel: DmPairingChannel; code: string } | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const { channel, code } = params as Record<string, unknown>;
  if (!isValidChannel(channel)) {
    return null;
  }
  if (typeof code !== "string" || code.length === 0) {
    return null;
  }
  return { channel, code: code.toUpperCase() };
}

// ---------------------------------------------------------------------------
// Handlers
// NOTE: GatewayRequestHandler receives { params, respond, context } only.
//       There is no broadcast parameter — that lives at the server
//       infrastructure layer, not in individual handlers.
// ---------------------------------------------------------------------------

export const dmPairingHandlers: GatewayRequestHandlers = {
  /**
   * dm.pair.list
   * Scope: operator.pairing
   *
   * Params: { channel: DmPairingChannel }
   * Result: { pending: DmPairingEntry[] }
   */
  "dm.pair.list": ({ params, respond, context }) => {
    const validated = validateListParams(params);
    if (!validated) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: `dm.pair.list requires { channel: one of ${SUPPORTED_CHANNELS.join(", ")} }`,
      });
      return;
    }

    const stateDir = getStateDir(context);
    const filePath = pairingFilePath(stateDir, validated.channel);
    const file = readPairingFile(filePath);
    const active = file.requests.filter((r) => !isExpired(r));

    // Prune expired entries from disk on read
    if (active.length !== file.requests.length) {
      writePairingFile(filePath, { ...file, requests: active });
    }

    respond(true, {
      pending: active.map((r) => toPublicEntry(r, validated.channel)),
    });
  },

  /**
   * dm.pair.approve
   * Scope: operator.pairing
   *
   * Params: { channel: DmPairingChannel; code: string }
   * Result: { ok: true; id: string }
   */
  "dm.pair.approve": ({ params, respond, context }) => {
    const validated = validateMutateParams(params);
    if (!validated) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "dm.pair.approve requires { channel, code }",
      });
      return;
    }

    const stateDir = getStateDir(context);
    const pairingPath = pairingFilePath(stateDir, validated.channel);
    const allowPath = allowFromFilePath(stateDir, validated.channel);

    const file = readPairingFile(pairingPath);
    const active = file.requests.filter((r) => !isExpired(r));
    const idx = active.findIndex((r) => r.code === validated.code);

    if (idx === -1) {
      respond(false, undefined, {
        code: "NOT_FOUND",
        message: `No pending pairing request with code ${validated.code} on ${validated.channel}`,
      });
      return;
    }

    const [approved] = active.splice(idx, 1);

    // Remove from pending file
    writePairingFile(pairingPath, { ...file, requests: active });

    // Add sender to allowFrom (deduplicated)
    const allowFrom = readAllowFrom(allowPath);
    if (!allowFrom.includes(approved.id)) {
      allowFrom.push(approved.id);
      writeAllowFrom(allowPath, allowFrom);
    }

    respond(true, { ok: true, id: approved.id });
  },

  /**
   * dm.pair.reject
   * Scope: operator.pairing
   *
   * Params: { channel: DmPairingChannel; code: string }
   * Result: { ok: true; id: string }
   */
  "dm.pair.reject": ({ params, respond, context }) => {
    const validated = validateMutateParams(params);
    if (!validated) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "dm.pair.reject requires { channel, code }",
      });
      return;
    }

    const stateDir = getStateDir(context);
    const pairingPath = pairingFilePath(stateDir, validated.channel);

    const file = readPairingFile(pairingPath);
    const active = file.requests.filter((r) => !isExpired(r));
    const idx = active.findIndex((r) => r.code === validated.code);

    if (idx === -1) {
      respond(false, undefined, {
        code: "NOT_FOUND",
        message: `No pending pairing request with code ${validated.code} on ${validated.channel}`,
      });
      return;
    }

    const [rejected] = active.splice(idx, 1);
    writePairingFile(pairingPath, { ...file, requests: active });

    respond(true, { ok: true, id: rejected.id });
  },
};
