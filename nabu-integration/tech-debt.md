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

### F-1 — GitHub labels for the new labeler entries

`.github/labeler.yml` gained `extensions: nabu-*` ×7 + `nabu-integration`;
the matching GH labels do not exist yet (labeler no-ops until created).
Create after landing — repo-metadata write, held with the rest of the
push/post batch.

### F-2 — seed compose lags root compose surfaces

`nabu-integration/spawn-seed/docker-compose.yml` does not forward
`OPENCLAW_DISABLE_BONJOUR` / `OTEL_*` and still applies
`cap_drop`/`no-new-privileges` to the CLI service only (seam D11 — root
compose hardens both services). The resynced docker-setup.sh guards the
missing pieces; close by resyncing the seed compose from root
`docker-compose.yml` the same way #14 resynced the setup script.

### F-3 — G6 validator dormant

`nabu-integration/scripts/validate-channel-isolation.mjs` carries the pin's
content re-formatted by repo oxfmt (import order + line wrapping; semantics
proven identical on all nine failure branches; mode 755 for the shebang —
pin ships 644). Not CI-wired: every existing instance would fail I3/I4 until
a default-deny channel baseline ships. Wire into CI when the first per-user
channel config lands; compress the oversized file header to a ≤3-line JSDoc
on that touch.
