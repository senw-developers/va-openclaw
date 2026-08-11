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
- Fix (needs a backend contract decision, tracked with B6-1 scheduling):
  operator-JWT with allowed-userIds issued by va-core-nest + HMAC-bind over
  `(organizationId, userId, sessionKey)`, or refuse the header on
  bearer-scoped calls.

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

### D-SEC-3 — credit latch does not gate gateway ingress (confirmed 2026-08-10)

`nabu-gateway` implements the credit/suspension latch as a `before_agent_reply`
hook. That hook has three call sites: two on the runner path gated to
`trigger === "cron"`, and one in the auto-reply resolver (channels/DM). Gateway
ingress — HTTP `/v1/responses`, `/v1/chat/completions`, WS `chat.send`, node
events — reaches the runners directly with `trigger: "user"` hardcoded
(`src/agents/command/attempt-execution.ts:607`, `:692`), so the latch never
fires. A suspended organization can still spend through the API path; what
actually stops it today is the backend stopping the container, and if that stop
fails the org is marked suspended while still serving. Options and blast radius
are recorded in memo `bbf338e6012b`; the fix is a core behavior change (every
plugin registering the hook would begin seeing user turns) and needs a
maintainer decision, not a drive-by.

### R-5 — metering is zero by decision (2026-08-10)

Backend metering is Cloudflare-AI-Gateway-log-only, and the seed's primary
(`openai/gpt-5.5`) plus fallback (`minimax`) both bypass Cloudflare, so no log
exists and nothing decrements. Operator accepted this explicitly; the seed
model choice stands. Closing it later means metering from the `llm_output`
payload we already send (provider-agnostic token counts, no cost) rather than
changing the model. Backend notified: memo `223c5bc49ecf`.

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
transport in nabu-gateway/nabu-email and removal of the http-only guards.
⚠ If the live `NABU_PUBLIC_API_URL` is https, nabu-1password and
nabu-google-workspace are dead today too — both hard-reject non-`http:`.

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
the gate into a live outage), and our own `OPENCLAW_ORGANIZATION_ID`
fail-closed throw (`nabu-email/index.ts:56-59`, same commit) must be verified
present in every tenant `.env` before rebuild — it is an independent break
vector that would be misdiagnosed as this one.

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

### C-4 — 1Password: route missing and no per-user model

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

### F-4 — skill-token resolver duplicated ×4; platform seam exists

`resolveApiTokenInput` is byte-identical in nabu-files, nabu-1password,
nabu-google-workspace, and nabu-email (env-source only; file/exec refs
degrade to ""). Core already offers the native seam: declare
`configContracts.secretInputs` paths in the manifests and core resolves refs
centrally (`src/secrets/runtime-config-collectors-plugins.ts`) with
config.patch refresh — the local copies then delete. Migrate all four in one
change with its own gates; do not patch copies individually.

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
