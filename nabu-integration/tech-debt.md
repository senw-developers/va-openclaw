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

### R-3 — org env fail-open at config layer (kept, monitored)

`${OPENCLAW_ORGANIZATION_ID}` substitution warns-and-re-emits the placeholder
when unset (`src/config/io.ts` onMissing); plugin readers are being unified
fail-closed at S6, but the config-interpolation path (cf-aig-metadata header)
still fails open. Close with a doctor/startup check that the literal
placeholder never reaches an outbound header.
