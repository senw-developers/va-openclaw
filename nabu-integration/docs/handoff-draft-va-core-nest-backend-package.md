# va-core-nest coordination package — POSTED 2026-08-10 to memory.va.team, hash `b9039d4127cc`.

> Target: our memory server (`memory.va.team`), tagged for the backend team.
> Subject: gateway parity port is code-complete — backend work now sequences the prod rollout.

## TL;DR for the backend team

The gateway fork just absorbed the senw parity port (per-user identity threading,
detached-media pipeline, plugin contract hardening, 1Password v3). **Nothing is
enabled in prod yet.** Each surface below stays dark until its backend gate
clears. Two items are urgent independent of the rollout: **B0** (your planned
image rebuild will strand the fleet without the protocol bump) and **B6-2**
(usage-ingest route is publicly exposed with no guard — standing HIGH since
2026-07-27).

## B0 — before you rebuild `openclaw:local` from our HEAD

A gateway built from the ported tree speaks **protocol v4**
(`packages/gateway-protocol/src/version.ts`). Your current WS client targets a
~2026.4.x image. Rebuilding without bumping the client envelope
(`minProtocol:4 / maxProtocol:4`, `client.id` allowed, `client.mode:"backend"`,
Ed25519 payload unchanged) reproduces senw's fleet-wide 1002/1008 pairing
outage. Sequence: client bump first, rebuild second.

Answers to your four 2026-08-04 questions (memo `39bb3b29b469`), all verified
against `feat/senw-parity` HEAD:

1. **paired.json stability vs `gateway.devices.trusted[]`** — device pairing
   persists as flat JSON under the state dir: `~/.openclaw/devices/paired.json`
   (+ `pending.json`, 5-min TTL), path built in `src/infra/pairing-files.ts:8-16`,
   written 0600. Stable across restarts/upgrades as long as the state-dir mount
   persists; no migration touches it. **`gateway.devices.trusted[]` does NOT
   exist** — the gateway zod schema is `.strict()`
   (`src/config/zod-schema.ts:1201-1203`), so adding it is a hard config error.
   Pre-seeding `paired.json` works but every field is load-bearing; the ones
   that bite: `deviceId` MUST equal `sha256(raw ed25519 pubkey).hex`
   (`src/infra/device-identity.ts:309-321`), `publicKey` must byte-match at
   connect, and **`tokens.operator` is mandatory** — tokenless records fail
   closed (`src/infra/device-pairing.ts:282-295`); token = any opaque non-blank
   string (constant-time compare, no derivation), `tokens.operator.role` must
   equal the key, `scopes` must be within `approvedScopes` (non-null array,
   `operator.*`-prefixed), `createdAtMs`/`approvedAtMs` required, and **omit
   `tokens.operator.issuer`** (a `shared-gateway-auth` issuer dies whenever the
   gateway secret generation changes). Your earlier NOT_PAIRED 1008s trace to
   the omitted `tokens.operator`. Ed25519 nonce-signature verification still
   runs on top of the token.
2. **CIDR operator auto-approve** — exists only for **node role**, opt-in, off
   by default: `gateway.nodes.pairing.autoApproveCidrs[]`
   (`src/config/types.gateway.ts:432-439`; policy
   `src/gateway/node-pairing-auto-approve.ts:34-79` — first-time, scope-free,
   non-browser node pairings from matching IPs only). **There is no CIDR path
   to operator role**; operator pairing is explicit (`device.pair.approve` RPC /
   `openclaw devices approve`) or the loopback-local silent path — not
   CIDR-configurable.
3. **`gateway.auth.token` rotation** — precedence: CLI `--token` > config
   literal > env `OPENCLAW_GATEWAY_TOKEN` (`src/gateway/auth-resolve.ts:39-121`).
   Auth is re-resolved per connection/request, but from the pinned runtime
   snapshot — and the reload plan classifies every `gateway.*` change as
   **restart** (`src/gateway/config-reload-plan.ts:138`), so patching a literal
   token via `config.patch` needs a gateway restart (and under
   `gateway.reload.mode:"hot"` is silently NOT applied). **Zero-restart
   rotation is supported** via SecretRef: set `gateway.auth.token` to
   `{source:"env"|…, provider, id}`, rotate the secret, call the
   `secrets.reload` RPC (scope `operator.admin`) — proven by
   `src/gateway/server.shared-token-hot-reload.test.ts:66-88`. Either way,
   expect all shared-secret WS sessions to drop with **close 4001 "gateway auth
   changed"** and reconnect with the new token.
4. **Image build/labels** — Dockerfile sets `org.opencontainers.image.{source,
url,documentation,licenses,title,description}` + base-image name/digest;
   `revision`/`version`/`created` are CI-injected only
   (`.github/workflows/docker-release.yml:155-157`). A plain local
   `docker build` has **no commit provenance**: `.dockerignore` excludes
   `.git` and no `GIT_COMMIT` arg is plumbed, so `dist/build-info.json` carries
   `commit: null` and `openclaw --version` prints `OpenClaw 2026.6.2` without a
   commit suffix. For your rebuild: pass `GIT_COMMIT`/`GIT_SHA` into the build
   env (read by `scripts/write-build-info.ts:22`) or label the image yourself;
   the authoritative identifier on CI images is the
   `org.opencontainers.image.revision` label.

**Protocol enforcement detail:** server speaks exactly v4
(`packages/gateway-protocol/src/version.ts`); your advertised
`[minProtocol, maxProtocol]` must straddle 4 or the connect is rejected with
JSON-RPC `INVALID_REQUEST` (`PROTOCOL_MISMATCH` detail) then
**`close(1002, "protocol mismatch")`**; invalid role → 1008; stale auth
generation → 4001.

## B5-1 — the S5 freeze switch (verification ask, ~15 min)

Read `apps/nabu-gateway/src/openclaw/openclaw.service.ts` and tell us exactly
what the responses/chat-completions relay puts in the OpenAI `user` field.
S5 (per-user ingress identity) requires a **numeric** per-user id there. If it
sends nothing or a non-numeric id, inbound-image persistence, attachment
session entries, and turn fileRefs all silently stop while model vision keeps
working — masked data loss. Also keep `user` consistent with any explicit
session-key header you send (owner split).

## B6 — files/ingest/email contracts (specs in the handover pack, attached)

- **B6-1 files-api user dimension**: accept `x-user-id` **alongside**
  `x-organization-id` (we send BOTH — composed tenancy); per-(org,user)
  storage + quota; ownership-scoped resolve with per-entry NOT_FOUND; 413
  envelope; idempotency key ≤128 chars, org-scoped dedupe. Ownership-scoped
  resolve is the single most important isolation control (fileIds are guessable
  integers). Gates S6a.
- **B6-2 usage-ingest guard** (URGENT, lockstep): skill-token guard (raw token
  in header, sha256 at rest, constant-time compare) must ship **together** with
  our token-sending change — guard alone silently 401s all metering; token
  alone changes nothing. Close the nginx public exposure at the same time.
  Gates S6b.
- **B6-3 smtp agentId mapping**: accept `{agentId}` + org header; per-org
  agentId→userId→mailbox; `SMTP_CONFIGURATION_NOT_CONFIGURED` error code.
  Gates S6c.
- **B6-4 / G2 Google scopes**: enumerate exactly which scopes our OAuth grants
  hold (`drive.readonly`? `drive.file`?). This decides whether the dual-scope
  Drive SKILL text ships (S6d is held un-applied until you answer).

## B7 — 1Password v3 broker (lockstep warning)

The ported plugin calls `POST /api/v1/onepassword/access-token` with
`{userId, channel}` + `x-skill-token` + `x-organization-id`, expects an `ops_`
service-account token back, 404 = no matching user, 412 = user hasn't
connected 1Password. **The moment the port deploys, `nabu.onepassword.refresh`
404s** — the RPC no longer exists (v3 has no cache to refresh). Retire the v1
`/token` route and drop `refreshIntervalMs` from `config.patch` payloads (now
schema-rejected). The seed ships the plugin `enabled:false` with the
`NABU_ONE_PASSWORD_SKILL_TOKEN` SecretRef prepared — enable is a one-line flip
after your route ships.

## Enablement schedule (prod)

| Surface                | Gate                         |
| ---------------------- | ---------------------------- |
| S5 per-user ingress    | B5-1 verified numeric        |
| S6a nabu-files         | B5-1 + B6-1                  |
| S6b usage-ingest token | B6-2 **lockstep**            |
| S6c nabu-email agentId | B6-3                         |
| S6d Drive SKILL        | B6-4 / G2                    |
| S7 nabu-1password      | B7                           |
| everything             | B0 before your image rebuild |
