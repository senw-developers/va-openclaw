# Fork tech-debt & security ledger

Divergences and known holes we carry knowingly. Every entry names the risk, the
current state, and what closes it. Companion to senw's `nabu-integration/tech-debt.md`
(their pin `9571e4775f` §D); items inherited from the parity port are marked.

## Security watch-list

### D-SEC-1 — `x-openclaw-session-key` header allows per-user impersonation (RED, inherited, both forks)

Any caller holding the gateway bearer token can pass an arbitrary
`x-openclaw-session-key`, and post-S5 the session owner derived from it decides
which user's Files-API scope (and by extension Google/1Password identity chain)
a request resolves as. `payload.user` is likewise client-supplied
(`src/gateway/open-responses.schema.ts`, `src/gateway/openai-http.ts`).

- Trust model today: the bearer is held only by va-core-nest, which is itself
  the authority on user identity — acceptable while that holds, wrong the
  moment any other caller gets a token.
- ⚠ **Raised 2026-08-11.** Until now this was latent for the backend's own
  traffic, because `parseSessionOwner` did not recognise their
  `api:<org>:<userId>:<ts>` key and returned null. It now does, so a bearer
  holder can select any user by crafting that header. Live impact is still nil
  — the backend drops `x-user-id` (C-3) — but the two land together: **their
  ownership column must not ship before this header is bound or refused.**
- **Operator decision 2026-08-11: ACCEPTED AS-IS FOR NOW.** Ship the
  functionality; harden later. This is defensible only because of the trust
  model above — the sole bearer holder is va-core-nest — and because senw's
  audit confirms **channel end-users cannot exploit it** (their session key is
  gateway-built from an authenticated sender, not from a header). Exposure is
  confined to operator/bearer scope.
- ⚠ The deferral does NOT relax the ordering constraint: if the backend ships
  files-api ownership enforcement (C-3) while the header is unbound, any bearer
  holder can act as any user. Either both land, or neither does.
- Agreed design when we do harden (adopted from senw, who documented but never
  implemented it — their ledger marks it "joint senw + nabu work, ticket when
  staffing security"): layered **operator-issued JWT carrying an allowed-userIds
  claim**, with the gateway deriving userId from the JWT and ignoring the header
  for files-api scoping, **plus an HMAC bind over
  `(organizationId, userId, sessionKey)`**. Sent to the backend as D6 in memo
  `6a4f1260846e`.

### D-SEC-2 — burned credentials in git history (G4, accepted)

`nabu-integration/spawn-seed/**` credential values committed pre-2026-08 remain
in history on `origin/develop`; files untracked and ignore rules fixed
(commit `39d492689c`), values treated as revoked/burned. No history scrub by
operator decision (2026-08-07) — pins and payload byte-verification stay valid.
Operator confirmed 2026-08-10: ALL keys rotated (incl. the two live local
`.env` values) — item closed; history exposure accepted.

## Behavior residuals

### R-1 — SSE history `refreshAsync` re-reads un-enriched (fork #30 residual)

The initial SSE history snapshot now carries fileRefs
(`src/gateway/sessions-history-http.ts` — enriched on purpose), but
`SessionHistorySseState.refreshAsync()` re-reads raw transcripts without
enrichment, so a mid-stream full-history refresh drops fileRefs until reload.
Close by threading an enrichment callback through `SessionHistorySseState`.

### R-2 — dropped senw hunks (deliberate divergences from pin `9571e4775f`)

- `canvasHostEnabled` re-graft (s5) dropped: zero code consumers in either
  tree (G10). Flagged back to senw.
- s6d Drive dual-scope SKILL + tool-string: **DROPPED PERMANENTLY (G2 = SKIP,
  2026-08-10)**. Verified in va-core-nest: the authorize URL requests exactly
  six scopes (`openid, email, profile, drive.file, calendar.events,
calendar.freebusy` — `google-workspace.constants.ts:18-26`, single call site,
  no override). `drive.readonly` is an explicitly deferred Phase-2 scope behind
  a paid CASA Tier 2 assessment. Our shipped `drive.file`-only SKILL wording is
  correct; the senw hunk would have made agents attempt read-all Drive calls
  that 403. Re-open only if the backend adds the scope AND every user
  re-consents (Google never widens an issued refresh token).

### R-4 — upload timeout asymmetry (accepted, Q16 reclassified)

Callers (nabu-media-upload middleware, S3 chokepoint) fail open at 10s while
the nabu-files transport allows 30s×3 attempts; a late-completing upload still
populates the idempotency cache. Accepted as-is: the budgets can't share a
constant without new SDK surface (cross-plugin imports are forbidden), and the
late cache write warms the next resolve rather than corrupting state. Revisit
only if abandoned-upload volume shows up in backend metrics.

### R-3 — org env fail-open at config layer (kept, monitored)

`${OPENCLAW_ORGANIZATION_ID}` substitution warns-and-re-emits the placeholder
when unset (`src/config/io.ts` onMissing); plugin readers are being unified
fail-closed at S6, but the config-interpolation path (cf-aig-metadata header)
still fails open. Close with a doctor/startup check that the literal
placeholder never reaches an outbound header.

Verified 2026-08-11 by running `openclaw doctor --deep` and `--lint --json`:
22 checks run, 0 skipped, 50 findings — and **zero** of them mention
organization id, placeholder or interpolation. No such check exists today, so
this entry is "write the check", not "run the tool". The same run confirmed the
degraded-token behavior we want elsewhere: a missing skill token surfaces as
`nabu_email is allowed but unavailable: config: …apiToken` and nothing else
breaks (see F-4).

### D-SEC-3 — credit latch did not gate gateway ingress (OUR SIDE FIXED 2026-08-11)

`nabu-gateway` implements the credit/suspension latch as a `before_agent_reply`
hook. Two of its three call sites were gated to `trigger === "cron"`, while
gateway ingress — HTTP `/v1/responses`, `/v1/chat/completions`, WS `chat.send`,
node events — reaches the runners with `trigger: "user"` hardcoded
(`src/agents/command/attempt-execution.ts:607`, `:692`), so the latch never
fired and a suspended organization could still spend through the API path.
**Both gates are removed (`c28c705e00`, `cb04e61645`), so the hook now fires on
every trigger.** This is inert until the backend flips `nabuEnabled`: the flag
defaults to enabled and the only other bundled consumer (memory-core)
self-guards. Blast radius recorded in memo `bbf338e6012b`. Remaining risk is
theirs — enforcement is off by their maintainer's decision, so nothing closes
the gate today regardless.

### R-5 — metering is zero by decision (2026-08-10)

Backend metering is Cloudflare-AI-Gateway-log-only, and the seed's primary
(`openai/gpt-5.5`) plus fallback (`minimax`) both bypass Cloudflare, so no log
exists and nothing decrements. Operator accepted this explicitly; the seed
model choice stands. Closing it later means metering from the `llm_output`
payload we already send (provider-agnostic token counts, no cost) rather than
changing the model. Backend notified: memo `223c5bc49ecf`.

### F-6 — one error-envelope parser per plugin (RESOLVED: accept the duplication)

`describeBackendError` is now copied in nabu-1password and nabu-google-workspace
(B4 landed the second copy). It stays that way by operator decision
(2026-08-11): consolidating would need a new Plugin-SDK subpath, and fork-only
duplication costs nothing at upstream-merge time while new core/SDK surface is
paid for at every merge. Unlike F-4 there is no existing core seam to reuse, so
there is nothing to migrate onto. Keep the two copies in sync by hand; if a
third plugin ever needs it, re-open rather than growing a fourth.

### C-5 — usage-ingest has never resolved its backend host (2026-08-11)

The seed points nabu-gateway at `http://nabu-gateway:6200`. That name only
resolves in the backend's _development_ compose; in staging and production
their containers sit on `app-network` alone, and tenants run on a different
host and cloud provider joined only by NetBird. So the metering POST has been
failing DNS since first deployment — this predates ADR-0008 rather than being
caused by it. Provenance: our own `e8770727e4` (2026-05-15) fixed the service
and port but left a dev-only hostname. Wider than one plugin: the backend has
no push path for nabu-files or nabu-gateway `apiBaseUrl` at all, so three
plugins are only reconfigurable via `config.patch`. Settle on the host with
`docker exec nabu-<N>-gateway getent hosts nabu-gateway` (expect exit 2).
Proposed fix: one public HTTPS base for all five plugins, which needs https
transport in nabu-gateway/nabu-email and removal of the http-only guards —
**shipped our side in `ad7da54a8f`; both http-only guards are gone.**

**Backend answered 2026-08-11 (memo `edb853d9371a`):**

- **Staging `NABU_PUBLIC_API_URL` is `100.91.98.113` with no scheme**, so
  `new URL()` throws and nabu-1password + nabu-google-workspace are dead on
  staging before any request is made. Their config fix, not ours.
- **Production is `http://100.80.107.181:6001`** — valid, and correct for the
  four skill routes on `app:6001`.
- ⚠ **Usage-ingest is still unfixed:** it lives on port **6200**, not 6001, so
  the production value does not cover it. Parked rather than chased, because
  metering is zero by decision (R-5).

## Backend-gated contract gaps (verified in va-core-nest 2026-08-10)

Findings from a read-only sweep of the sibling backend at `../va-core-nest`
(branch develop). These are THEIR builds, but each one decides whether one of
our ported surfaces can be enabled — and three of them break on image rebuild.

### C-1 — SMTP rejects `agentId`: nabu-email breaks on rebuild (BLOCKER)

**Date-bounded 2026-08-11: production is NOT broken today.** `agentId` entered
the body in `72bd614c8f` (parity S6, 2026-08-07); the deployed image is the
pre-port `2026.4.9` line, whose last commit `fb68518953` sends raw tool params
only. So this is strictly a rebuild gate. Two asks recorded with the backend:
their DTO field must be **optional-on-arrival** treating a missing `agentId` as
`main` (enforcing a required field while April images are live would convert
the gate into a live outage) — **the backend agreed to this on 2026-08-11
(memo `edb853d9371a`), so the ordering hazard is closed** — and our own
`OPENCLAW_ORGANIZATION_ID` handling must be verified present in every tenant
`.env` before rebuild. ⚠ Corrected 2026-08-11: the fail-closed throw described
here was REMOVED in `ad7da54a8f` — nabu-email now warns once and sends an EMPTY
org header, so a missing env var is fail-OPEN, not a break vector. That is
tolerable only while the backend resolves org from the token hash alone; it
becomes a real hole the moment they add the org conjunct to SMTP.

`nabu_email_send` / `nabu_email_fetch` spread `agentId` into the request body;
the backend's send/fetch DTOs have no such field and its global ValidationPipe
runs `forbidNonWhitelisted: true`. Every email tool call returns 400 the moment
a tenant runs the ported image, and nabu-email ships `enabled: true` in the
seed. Their fix is two lines (accept-and-ignore); it is a Phase-0 rebuild gate.
Their mailbox is also structurally one-per-org (UNIQUE on `organization_id`),
so per-agent routing does not exist — our tool descriptions were corrected to
stop promising it.

### C-2 — usage-ingest: the lockstep risk is INVERTED (we are ahead)

The route is still `@Public()` with org read from the request body, but our
nabu-gateway plugin already sends `x-skill-token` — resolving to `""`, because
the seed entry has no `apiToken` and no backend push path mints one. Two
consequences: the plugin's manifest text (corrected) must not claim a guard
exists, and the backend must run dual-accept (log-only) before fail-closing, or
metering 401s silently — which is fail-OPEN billing, worse than today.

### C-3 — files-api has no user dimension at all

Repo-wide, the backend reads no `x-user-id`; skill uploads persist
`created_by = 0` and the resolve query carries no ownership predicate. Our
per-user header is a silent no-op server-side today, and cross-user file
isolation is currently held only by our client-side idempotency-key convention.
Ownership must be recorded on write and enforced on resolve before S6a is
enabled in prod.

### C-4 — 1Password: route missing and no per-user model (CLOSED 2026-08-11)

**Our side shipped in `ad7da54a8f`:** `ACCESS_TOKEN_PATH` is now
`/api/v1/onepassword/token` and both error branches read org-centric. The
`{userId, channel}` body is still built and POSTed — demoted to audit-only, which
is what the decision below permits; the backend route takes no `@Body()` and
ignores it. Nothing further is owed on this item; the paragraphs below are kept
as the decision record.

**RESOLVED 2026-08-11 (operator): 1Password stays ORGANIZATION-SCOPED.** No
per-user vaults, no per-user `ops_` tokens, no new backend model. Our plugin is
the side that must move: `ACCESS_TOKEN_PATH` is
`/api/v1/onepassword/access-token`
(`extensions/nabu-1password/src/nabu-1password.constants.ts:5`) but the backend
only exposes org-scoped `POST /api/v1/onepassword/token` with no body — so
today every call 404s at the router. Change the constant, drop or demote the
`{userId, channel}` body to audit-only, and reword both error branches
org-centric. This also unblocks B3/B4/B5, which all sat behind the route
question. Related decisions: we keep our own status codes rather than pushing
`PreconditionFailed` onto the backend (they adapt), we keep a 403 for
"org configured, caller not granted", and the error parser targets the real
backend envelope `{error, reason?, detail?}` — **not** `{code, message}`.

The backend serves `POST /api/v1/onepassword/token` (no body, org-scoped, one
shared `ops_` token per org); our v3 plugin calls
`/api/v1/onepassword/access-token` with `{userId, channel}` and expects 404/412
semantics. The gap is a whole per-user model, not a route rename. Seed keeps
`enabled: false` — verify no live tenant has flipped it before rebuild.

## S8 follow-ups (2026-08-07)

### F-1 — GitHub labels for the labeler entries (CANCELLED 2026-08-10)

Operator decision: no nabu labels on this fork. The 8 labeler.yml entries
were reverted (labels were never created on GitHub). If labels are ever
wanted, restore the entries from commit `85c3c9d2a6` and create the labels
together.

### F-2 — seed compose lags root compose surfaces (CLOSED 2026-08-10)

Gateway service now carries the root-compose hardening (`cap_drop`
NET*RAW/NET_ADMIN + `no-new-privileges` — seam D11 retired) and the
`OPENCLAW_DISABLE_BONJOUR`/core `OTEL*\*` passthroughs. Remaining root-only
surfaces (per-signal OTLP endpoint overrides, host-gateway extra_hosts) are
deliberate omissions until a tenant needs them.

### F-4 — skill-token resolver duplicated ×4 (WON'T FIX: core seam is fail-fatal)

`resolveApiTokenInput` is byte-identical in nabu-files, nabu-1password,
nabu-google-workspace and nabu-email, and it stays that way.

We migrated all four onto core's native seam
(`configContracts.secretInputs`, `src/secrets/runtime-config-collectors-plugins.ts`)
and reverted it the same day. Core resolution is **fatal by contract**: an unset
or empty env var makes `resolveEnvRefs` throw
(`src/secrets/resolve.ts:402-408`), `ensureResolvableSecretRefsOrRespond`
catches it, and `config.patch` is rejected with `INVALID_REQUEST`
(`src/gateway/server-methods/config.ts:363-378`) — taking down the backend's only
push channel because one plugin's token is missing.
`PluginManifestSecretInputContracts` (`src/plugins/manifest.ts:288-296`) offers
only `bundledDefaultEnabled` and `paths`; there is no optional/non-fatal mode to
opt into.

Operator decision 2026-08-11: **a missing skill token must disable only that
plugin, never block config.patch.** Local resolution degrades to `""` → a
per-call 401 on that plugin alone, which is the required behavior. Each copy
carries a JSDoc saying why it is not declared as a core secretInput, so the
migration is not attempted a third time. Adding an `optional` flag to the core
contract would work but is new core surface for a fork-only problem — see the
conflict-surface rule.
Each call site keeps a `typeof === "string"` narrowing so a disabled plugin —
whose refs are deliberately left unresolved — fails closed instead of sending
`[object Object]`.

### F-5 — seed lacks explicit `plugins.bundledDiscovery` (RESOLVED: won't add)

Verified 2026-08-10: `bundledDiscovery` is a **deprecated shipped-upgrade
marker** (`src/config/types.plugins.ts:71` — "accepted for old restrictive
allowlist configs"), not a recommended surface. Seeding a deprecated key
violates the canonical-config rule; the doctor hint only appears on
already-invalid configs and the seed validates clean. No change. Related:
nabu-model-router deliberately has no package.json (T10/#34), so the
plugin-inventory generator skips it — intentional exclusion, do not "fix"
by adding one.

### F-3 — G6 validator dormant

`nabu-integration/scripts/validate-channel-isolation.mjs` carries the pin's
content re-formatted by repo oxfmt (import order + line wrapping; semantics
proven identical on all nine failure branches; mode 755 for the shebang —
pin ships 644). Not CI-wired: every existing instance would fail I3/I4 until
a default-deny channel baseline ships. Wire into CI when the first per-user
channel config lands; compress the oversized file header to a ≤3-line JSDoc
on that touch.
