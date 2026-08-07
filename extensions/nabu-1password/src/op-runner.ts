import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { OpenClawPluginApi } from "../api.js";
import {
  DEFAULT_CHILD_HOME,
  DEFAULT_CHILD_PATH,
  LOG_PREFIX,
  OP_BINARY,
  OP_CACHE_DISABLED,
  OP_CACHE_ENV_VAR,
  OP_EXEC_TIMEOUT_MS,
  OP_MAX_OUTPUT_BYTES,
  OP_OPERATIONS,
  OP_TOKEN_ENV_VAR,
  REDACTED_OP_TOKEN,
} from "./nabu-1password.constants.js";
import type { Nabu1PasswordParams, OpOperation } from "./nabu-1password.interface.js";
import { fingerprint } from "./token.js";

/** Thrown when the requested operation is outside the read-only whitelist. */
export class OperationNotAllowedError extends Error {}
/** Thrown when a required field for an operation is missing or malformed. */
export class MissingArgError extends Error {}

/** Reject control characters (incl. newlines) in any value forwarded to op.
 * Range spelled as escape text, not raw bytes: raw control chars make git
 * classify this file binary (no diff/blame/grep). */
const SAFE_VALUE = /^[^\x00-\x1f]+$/;

function requireSafe(label: string, value: string): string {
  if (!SAFE_VALUE.test(value)) {
    throw new MissingArgError(`${label} contains invalid characters`);
  }
  return value;
}

/**
 * Map a validated operation + params to the exact `op` argv.
 *
 * Pure and total over the read-only operation set; throws for any operation
 * outside the whitelist or any missing required field. This is the load-bearing
 * boundary — argv is never built from free-form input.
 */
export function buildOpArgv(operation: string, params: Nabu1PasswordParams): string[] {
  if (!(OP_OPERATIONS as readonly string[]).includes(operation)) {
    throw new OperationNotAllowedError(`Operation not allowed: ${operation}`);
  }
  const op = operation as OpOperation;
  switch (op) {
    case "read": {
      const reference = params.reference;
      if (!reference) {
        throw new MissingArgError("operation=read requires a `reference` (op://vault/item/field)");
      }
      if (!reference.startsWith("op://")) {
        throw new MissingArgError("`reference` must start with op://");
      }
      return ["read", "--no-newline", requireSafe("reference", reference)];
    }
    case "item-get": {
      if (!params.item) {
        throw new MissingArgError("operation=item-get requires an `item`");
      }
      const argv = ["item", "get", requireSafe("item", params.item), "--format=json"];
      if (params.vault) {
        argv.push("--vault", requireSafe("vault", params.vault));
      }
      if (params.fields && params.fields.length > 0) {
        argv.push("--fields", params.fields.map((field) => requireSafe("field", field)).join(","));
      }
      return argv;
    }
    case "item-list": {
      const argv = ["item", "list", "--format=json"];
      if (params.vault) {
        argv.push("--vault", requireSafe("vault", params.vault));
      }
      return argv;
    }
    case "vault-list": {
      return ["vault", "list", "--format=json"];
    }
  }
}

/** Structured tool result for one `op` invocation. */
export interface OpRunResult {
  operation: OpOperation;
  ok: boolean;
  value?: string;
  result?: unknown;
  truncated?: boolean;
  error?: string;
  code?: number | null;
  stderr?: string;
}

/**
 * Run `op` with the user's token scoped to the CHILD env only.
 *
 * A minimal baseEnv keeps the gateway's other secrets out of the child;
 * OP_CACHE=false stops op from writing the user's secret to a shared on-disk
 * cache. The token never touches the gateway's process.env.
 */
export async function runOp(
  api: OpenClawPluginApi,
  operation: OpOperation,
  argv: string[],
  opToken: string,
  meta: { userId: number; channel: string },
): Promise<OpRunResult> {
  const startedAt = Date.now();
  const result = await runCommandWithTimeout([OP_BINARY, ...argv], {
    timeoutMs: OP_EXEC_TIMEOUT_MS,
    baseEnv: {
      PATH: process.env.PATH ?? DEFAULT_CHILD_PATH,
      HOME: process.env.HOME ?? DEFAULT_CHILD_HOME,
    },
    env: { [OP_TOKEN_ENV_VAR]: opToken, [OP_CACHE_ENV_VAR]: OP_CACHE_DISABLED },
    maxOutputBytes: OP_MAX_OUTPUT_BYTES,
  });
  const latency = Date.now() - startedAt;
  const redact = (text: string): string => text.split(opToken).join(REDACTED_OP_TOKEN);
  const stderr = redact(result.stderr ?? "");

  api.logger.info(
    `${LOG_PREFIX} ${operation} user=${meta.userId} channel=${meta.channel} code=${result.code} latency_ms=${latency} fp=${fingerprint(opToken)}`,
  );

  if (result.termination === "timeout" || result.termination === "no-output-timeout") {
    return { operation, ok: false, error: `op timed out after ${OP_EXEC_TIMEOUT_MS}ms` };
  }
  if (result.code !== 0) {
    const classified = classifyOpError(stderr, result.code);
    return { operation, ok: false, ...classified, stderr: stderr.slice(0, 600) };
  }

  const stdout = redact(result.stdout ?? "");
  const truncated = Boolean(result.stdoutTruncatedBytes && result.stdoutTruncatedBytes > 0);
  if (operation === "read") {
    return { operation, ok: true, value: stdout, truncated };
  }
  try {
    return { operation, ok: true, result: JSON.parse(stdout), truncated };
  } catch {
    return { operation, ok: true, value: stdout, truncated };
  }
}

function classifyOpError(
  stderr: string,
  code: number | null,
): { error: string; code: number | null } {
  const text = stderr.toLowerCase();
  if (/isn't an item|no item matching|not found|doesn't exist|isn't a vault/.test(text)) {
    return { error: "not found", code };
  }
  if (/authentication|service account|invalid token|\(401\)|unauthorized/.test(text)) {
    return {
      error: "op auth failed (the brokered token may lack access to that vault/item)",
      code,
    };
  }
  return { error: "op command failed", code };
}
