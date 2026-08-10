#!/usr/bin/env node
/**
 * D21 channel-isolation validator (nabu-senw).
 *
 * Static safety checks for per-user inbound-channel config (Telegram/WhatsApp).
 * Enforces the default-deny posture that keeps unknown senders OFF the
 * super-admin `main` agent and prevents cross-user routing leaks. See
 * nabu-integration/SPEC.md D21.
 *
 * WHY this exists: OpenClaw `bindings[]` has no deny tier — unbound inbound
 * deterministically falls back to the default agent (`main`). Isolation is
 * therefore enforced at the channel access-control layer (dmPolicy/allowFrom),
 * and these invariants guard that it stays correct as senw-core writes
 * channel config via config.patch.
 *
 * Usage:
 *   node nabu-integration/scripts/validate-channel-isolation.mjs [path/to/openclaw.json]
 * Default path: nabu-integration/instances/nabu-demo/.openclaw/openclaw.json
 * Exit 0 = all invariants hold; exit 1 = at least one violation (CI-blocking).
 *
 * NOTE: parses with JSON.parse (our configs are plain JSON). If a config uses
 * JSON5 comments, pre-strip them or swap in a JSON5 parser. The runtime
 * "routing-conformance fuzzer" (block→no usage hook; allow→usage hook with
 * correct agentId) is a separate integration test against a live gateway —
 * out of scope for this static linter.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PER_USER_CHANNELS = ["whatsapp", "telegram"];
const SUPER_ADMIN_AGENT = "main";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath =
  process.argv[2] ?? path.resolve(here, "../instances/nabu-demo/.openclaw/openclaw.json");

const failures = [];
const fail = (id, msg) => failures.push(`  ✘ [${id}] ${msg}`);

let cfg;
try {
  cfg = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  console.error(`Could not read/parse config at ${configPath}: ${err.message}`);
  process.exit(2);
}

const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
const channels = cfg.channels ?? {};

// I1 — no binding routes to the super-admin agent.
for (const [i, b] of bindings.entries()) {
  if (b?.agentId === SUPER_ADMIN_AGENT) {
    fail(
      "no-binding-to-main",
      `bindings[${i}] routes to "${SUPER_ADMIN_AGENT}" — the super-admin agent must have NO channel binding.`,
    );
  }
}

// I2 — no wildcard / channel-wide fallback that would re-create unbound→main.
for (const [i, b] of bindings.entries()) {
  const m = b?.match ?? {};
  if (m.accountId === "*") {
    fail(
      "no-wildcard-binding",
      `bindings[${i}] uses accountId:"*" — wildcard fallback re-creates the unbound→main leak.`,
    );
  }
  if (PER_USER_CHANNELS.includes(m.channel) && !m.accountId && !m.peer) {
    fail(
      "no-channel-wide-binding",
      `bindings[${i}] matches channel "${m.channel}" with no accountId/peer — too broad; bind per-account.`,
    );
  }
}
for (const ch of PER_USER_CHANNELS) {
  if (channels[ch] && channels[ch].defaultAccountId != null) {
    fail(
      "no-default-account",
      `channels.${ch}.defaultAccountId is set — an unbound message could adopt that identity and route to its agent. Remove it.`,
    );
  }
}

// I3 — every named per-user account that is route-bound has EXACTLY one allowFrom.
for (const ch of PER_USER_CHANNELS) {
  const accounts = channels[ch]?.accounts ?? {};
  for (const [accId, acc] of Object.entries(accounts)) {
    const isBound = bindings.some((b) => b?.match?.channel === ch && b?.match?.accountId === accId);
    const allowFrom = Array.isArray(acc?.allowFrom) ? acc.allowFrom : null;
    if (isBound) {
      if (acc?.dmPolicy !== "allowlist") {
        fail(
          "account-allowlist",
          `channels.${ch}.accounts.${accId} is route-bound but dmPolicy="${acc?.dmPolicy}" (must be "allowlist").`,
        );
      }
      if (!allowFrom || allowFrom.length !== 1) {
        fail(
          "one-allowFrom-per-account",
          `channels.${ch}.accounts.${accId} is route-bound but allowFrom has ${allowFrom ? allowFrom.length : "no"} entries (must be exactly 1 — the owning user).`,
        );
      }
    }
  }
}

// I4 — when a per-user channel block exists, the TOP-LEVEL fallback is deny.
for (const ch of PER_USER_CHANNELS) {
  const c = channels[ch];
  if (!c) continue;
  if (c.dmPolicy !== "disabled") {
    fail(
      "top-level-deny",
      `channels.${ch}.dmPolicy="${c.dmPolicy}" — top-level fallback must be "disabled" (per-user access lives on the accounts).`,
    );
  }
  if (Array.isArray(c.allowFrom) && c.allowFrom.length > 0) {
    fail(
      "empty-top-level-allowFrom",
      `channels.${ch}.allowFrom is non-empty — top-level allowlist must be [] so only named accounts are reachable.`,
    );
  }
}

// I5 — groups disabled at the top level (open per-account explicitly + deliberately).
for (const ch of PER_USER_CHANNELS) {
  const c = channels[ch];
  if (!c) continue;
  if (c.groupPolicy && c.groupPolicy !== "disabled") {
    fail(
      "top-level-group-deny",
      `channels.${ch}.groupPolicy="${c.groupPolicy}" — groups must be "disabled" at the top level (needs its own threat model to open).`,
    );
  }
}

if (failures.length > 0) {
  console.error(`D21 channel-isolation: FAIL (${failures.length}) — ${configPath}`);
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`D21 channel-isolation: PASS — ${configPath}`);
console.log(
  "  ✔ no binding to main · no wildcard/default-account fallback · one-allowFrom-per-bound-account · top-level deny · groups disabled",
);
