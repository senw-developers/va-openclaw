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
- s6d Drive dual-scope SKILL + tool-string held pending G2 (backend scope
  enumeration); `drive.file`-only backend would make the SKILL mislead agents.

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
