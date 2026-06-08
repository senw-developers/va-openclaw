# Upstream Merge Playbook (openclaw fork → fork)

> **Purpose.** Reproduce, on another openclaw fork (e.g. `nabu-senw`), the clean upstream
> catch-up merge we just completed on `va-openclaw`. This is a **method + a verified drift map**,
> not a copy-paste patch — your fork's customizations differ, so your conflict *set* differs, but
> the **upstream-side changes are identical** and the **verification gates are identical**.
>
> **Your single best asset:** `va-openclaw` on branch `develop` is now a **fully-resolved,
> green, builds-and-runs reference**. For any surface your fork shares with it (nabu plugins,
> gateway file-refs, model router, deliver tool, the SDK subpaths), **read how we resolved it
> there and mirror the resolution**. Every file:line below was verified against that branch.

---

## Part 0 — Ground rules (set these before touching git)

1. **The human drives the merge.** Do **not** `git pull upstream` / `git merge` yourself. The
   operator runs the actual `git merge main` (after syncing their `main` to upstream `openclaw/openclaw`).
   Your job is **conflict analysis + resolution + verification**, not initiating the merge.
2. **Branch hygiene.** Merge into `develop` (or the fork's integration branch), never straight into `main`.
   Confirm `git status` is clean before the operator starts; if dirty, stop and surface it.
3. **The fork's `nabu-integration/` (or equivalent customization folder) is the source of truth**
   for what must survive. Read it fully *before* resolving anything.
4. **Never expose secrets.** `.env` files hold live keys (Cloudflare AI Gateway, MiniMax, Files-API
   skill tokens, gateway auth). Read variable **names** only, never values; never commit them.
5. **Commits:** use `--no-verify` — the `oxfmt` pre-commit hook chokes on the ~20k-file merge diff
   and will hang. Group commits logically (merge / lockfile / type-fixes / baseline / Docker).

---

## Part 1 — The process (the loop that produced a clean result)

```
1. ANALYZE   → enumerate every conflict, classify by reason, write a resolution plan (don't resolve yet)
2. RESOLVE   → in dependency order: trivial/took-theirs first, fork-surface rewrites last
3. TYPECHECK → tsgo (core + extensions + test-types) until 0 errors — this surfaces the HIDDEN breakages
4. CONTRACTS → plugin-sdk export/baseline checks (if you touched SDK subpaths)
5. LOCKFILE  → regenerate pnpm-lock.yaml from scratch (the merge artifact is almost always wrong)
6. BUILD     → docker build → verify the image boots + all fork plugins load
```

**Why this order.** Steps 1–2 leave the tree *looking* merged but it won't compile — upstream renamed
packages and moved modules in ways git can't see (a clean auto-merge of a file whose *imports* now point
at deleted paths). Step 3 (`tsgo`) is what actually finds those. Resolve fork-specific surfaces **last**
because they depend on knowing where upstream relocated the seams they hook into.

### Step 1 detail — analysis dossier
For each conflicted file capture: **(a)** why it conflicted (upstream refactor vs fork edit vs both),
**(b)** what the fork added that must survive, **(c)** the resolution (ours / theirs / rewrite), **(d)**
the upstream relocation it now has to target. We kept this as `nabu-integration/docs/merge-conflict-resolution-plan.md`.
Do the same for your fork.

---

## Part 2 — Upstream API drift map (DIRECTLY REUSABLE — same upstream)

These are the upstream changes between the old merge-base and current `main`. Your fork will hit
**every one of these** wherever your code touches the affected symbol. Each row is verified in
`va-openclaw@develop` — open that file as your reference.

| What changed upstream | Old (pre-merge) | New (current) | Verified reference (va-openclaw) |
|---|---|---|---|
| **typebox package renamed** | `@sinclair/typebox` | `typebox` (bare) | `extensions/nabu-email/index.ts:2`; `src/agents/tools/deliver-tool.ts:3` |
| **media helpers extracted to a package** | `src/media/{mime,...}` relative imports | `@openclaw/media-core/*` (e.g. `@openclaw/media-core/mime` for `extensionForMime`/`detectMime`) | `src/gateway/openresponses-http.ts:15`; `src/agents/tools/deliver-tool.ts:6` |
| **agent runtime internalized + renamed** | `src/agents/pi-embedded-runner/` | `src/agents/embedded-agent-runner/` (old dir **deleted**) | `src/agents/embedded-agent-runner/run/attempt.ts` (pi-embedded-runner is gone — confirm with `find src -type d -name pi-embedded-runner` → empty) |
| **SessionManager moved out of the pi dep** | `@mariozechner/pi-coding-agent` (`SessionManager`) | `src/agents/sessions/session-manager.js` | `src/gateway/openresponses-http.ts:14` |
| **session reads are async now** | sync `readSessionMessages(...)` | `await readSessionMessagesAsync(sessionId, storePath, sessionFile, { mode, reason })` | `src/gateway/openresponses-http.ts:53`; def at `src/gateway/session-utils.fs.ts:579` |
| **tool-result hook → middleware contract** | `api.on("tool_result", ...)` (pi-extension hook) | `AgentToolResultMiddleware` — register via `api.registerAgentToolResultMiddleware(mw, { runtimes: ["openclaw"] })`; bundled plugins declaring `contracts.agentToolResultMiddleware: ["openclaw"]` auto-activate **regardless of enabled status** | `extensions/nabu-media-upload/index.ts:13-15` + its `openclaw.plugin.json` |

> **How to use this table:** before resolving any conflicted (or even auto-merged) file in your fork,
> grep it for the **old** form. If present, it will not compile post-merge — retarget to the **new** form.
> `tsgo` (Step 3) will catch the ones you miss, but grepping the table first is faster than iterating.

---

## Part 3 — Conflict triage & decision framework

Classify every conflict into one of four buckets and apply the rule:

### A. Trivial upstream refactor vs fork cosmetic edit → **take theirs**
Most volume. Typically your fork removed an `as X` cast or tweaked formatting on a line upstream
heavily refactored. Take upstream (`git checkout --theirs -- <file>` or accept theirs in the hunk).
**~23 of our 48 conflicts were this.**

> ⚠️ **The silent cast-removal trap.** Some of these are *not even conflicts* — git auto-merges your
> fork's cast-removal into upstream's stricter-typed code, producing a file that merges cleanly but
> **fails `tsgo`**. We hit 3: `extensions/synology-chat/src/test-http-utils.ts`,
> `extensions/telegram/src/bot-message-context.body.ts`, `extensions/feishu/src/setup-core.ts`.
> Fix: revert those to upstream (`git checkout main -- <file>`). **You only find these in Step 3** —
> do not skip the extensions/test tsgo lanes.

### B. Fork added a feature on a seam upstream relocated → **rewrite onto the new seam**
The hard ones. Your fork's logic must survive, but the function/file/call-site it hooked into moved.
**Take upstream's structure as the spine, re-graft the fork logic at the new location.** Worked examples:

- **Gateway file-refs enrichment.** Upstream moved the broadcast out of `server.impl.ts` into
  `server-session-events.ts`. We re-applied enrichment in `createMessageEventBroadcastHandler`,
  computing `fileRefs` from the **RAW** message *before* projection (because `projectChatDisplayMessage`
  strips the custom details the refs are derived from). Reference: `src/gateway/server-session-events.ts:11`
  (import) and `:188-205` (raw-message compute at `attachOpenClawTranscriptMeta` → project at `:192` →
  enrich at `:199`). Helper lives in the fork-only `src/gateway/chat-file-refs.ts`.
- **The big HTTP endpoint (`openresponses-http.ts`).** Upstream rewrote it with a multi-tool-call loop
  and a `CliDeps` shape. We took **upstream's loop as the spine** and re-grafted the nabu Files-API
  surface onto it, then fixed the drift-map imports (rows 4/5/6 above). Reference: the whole resolved
  `src/gateway/openresponses-http.ts`.
- **New RPCs on a moved registry.** Upstream centralized method/scope tables in
  `src/gateway/methods/core-descriptors.ts`. We added our `dm.pair.{list,approve,reject}` rows there
  (`:176-178`, scope `operator.pairing`) + a lazy handler loader in `server-methods.ts`; the handler
  itself is fork-only (`src/gateway/server-methods/dm-pairing.ts`).
- **The Cloudflare AI Gateway streamFn wrapper.** Re-applied in the renamed runner at
  `src/agents/embedded-agent-runner/run/attempt.ts:2701-2732` (injects the `cf-aig-metadata` header).
  Note the field rename it required (`params.model.provider` → `params.provider`).

### C. Fork feature whose old integration mechanism upstream deleted → **re-express via the new contract**
When the *mechanism* is gone (not just moved), port to the new API. Our case: the media-upload feature
used the deleted `api.on("tool_result")` pi-hook. We re-expressed it as a **new bundled plugin**
(`extensions/nabu-media-upload/`) using the `AgentToolResultMiddleware` contract — keeping core
extension-agnostic. If your port needs a new public SDK surface, see Part 3-D.

### D. Your port needs a new plugin-sdk subpath → **add it properly (4 wiring points)**
We needed `splitMediaFromOutput` exposed to the plugin. Adding a subpath means **all four**:
1. `src/plugin-sdk/<name>.ts` — the re-export (`src/plugin-sdk/media-parse.ts:1-9`).
2. `package.json` `exports` map entry → `./dist/plugin-sdk/<name>.js`/`.d.ts` (`package.json:476-479`).
3. `scripts/lib/plugin-sdk-entrypoints.json` (`:85`).
4. `docs/plugins/sdk-subpaths.md` (`:323`).
Then regenerate the API baseline: `pnpm plugin-sdk:api:gen` (writes `docs/.generated/plugin-sdk-api-baseline.sha256`).
Skipping any one fails the contract checks in Step 4.

### Cross-cutting rules
- **`package.json` deps:** take upstream's, then **drop root deps that belong to plugins you don't ship**
  (we dropped `nostr-tools`/`zca-js`). Per the architecture rules, plugin-only deps stay plugin-local.
- **Preserve intentional security toggles** with a comment explaining *why* (e.g. our commented-out
  non-loopback Control-UI origin guard for containerized deploy — `src/gateway/server-runtime-config.ts:159-170`).
  Don't let an "accept theirs" silently re-enable something the fork deliberately disabled.

---

## Part 4 — Verification gates (exact commands, in order; all must be green before commit)

Run from repo root. **These script names are verified to exist** (`package.json` line in parens).

```bash
# 3 — TYPECHECK (the drift-finder). tsgo:core alone is NOT enough — it excludes tests + extensions.
pnpm tsgo                  # = tsgo:core, tsconfig.core.json, excludes **/*.test.ts + test/** (:1849 → :1851)
pnpm tsgo:extensions       # extensions lane — catches the cast-removal trap (:1854)
pnpm check:test-types      # = tsgo:test — test-file types (:1478)

# 4 — PLUGIN-SDK CONTRACTS (only if you touched src/plugin-sdk/* or its exports)
pnpm plugin-sdk:check-exports                      # (:1617)
pnpm lint:plugins:plugin-sdk-subpaths-exported     # (:1594)
pnpm plugin-sdk:api:check                          # baseline check (:1615); regen with plugin-sdk:api:gen (:1616)

# 6 — BUILD + IMAGE VERIFY (operator usually runs docker; build:docker is bundle-only, no typecheck)
DOCKER_BUILDKIT=1 docker build -t openclaw:local .
# Dockerfile: bundling at line 119 (pnpm build:docker, :1452), runtime-assets stage at line 127.
# Then verify the image (ephemeral --rm containers, nothing persistent):
docker run --rm --entrypoint node openclaw:local dist/index.js --version
docker run --rm --entrypoint node openclaw:local dist/index.js plugins list | grep -i <your-fork-prefix>
```

Local full `check`/`test` exist (`check`:1458, `check:changed`:1462, `test`:1680, `test:changed`:1686)
but are heavy — prefer the narrow `tsgo` lanes locally and push broad proof to the remote test harness.
**Do not run heavy `tsgo`/`build` that OOM-crashes the operator's docker** — coordinate.

---

## Part 5 — Gotchas & traps (these cost us the most time)

1. **The lockfile from the merge is wrong — regenerate it.** The merge artifact `pnpm-lock.yaml` was
   missing the fork's workspace importers (and a native-binary entry). Symptom: `pnpm install --frozen-lockfile`
   fails in Docker. Fix:
   ```bash
   rm pnpm-lock.yaml && pnpm install --lockfile-only   # metadata only, no tarball downloads
   pnpm install --offline                              # link from store to validate
   ```
2. **Flaky network on big native tarballs.** If installs/builds abort mid-tarball (pnpm "error 23"):
   ```bash
   npm_config_network_concurrency=2 npm_config_fetch_timeout=1800000 \
   npm_config_fetch_retries=12 pnpm install
   ```
   The Docker `runtime-assets` stage seeds **all** platform variants (darwin/win32/musl/arm) for the
   offline prune; on a flaky link, make that store-seed **tolerant** of non-target-platform fetch
   failures (the prune keeps only linux/glibc anyway). See `va-openclaw` Dockerfile commit `93ee52f8e7`.
   `MTU 1400` did **not** help — don't waste time there.
3. **tsgo lane coverage.** `pnpm tsgo` ≠ "all types checked." It's core-only. The extensions + test
   lanes are where fork plugins and the cast-removal trap live. Run all three.
4. **`build:docker` does NOT typecheck** — it's transpile-only (tsdown bundling). A green docker build
   does **not** mean types are sound. Gate on `tsgo` separately (Step 3).
5. **Middleware/contract plugins show "disabled" but still fire.** A bundled plugin declaring the
   `agentToolResultMiddleware` contract auto-activates regardless of its enabled flag, so `plugins list`
   showing it "disabled" is expected — verify the **behavior** at runtime, not the list status.
6. **Node version warning is harmless.** Repo wants Node 24; a local Node 22 only emits an engine
   warning. Not an error.

---

## Part 6 — Runbook checklist (per merge)

- [ ] Operator confirms `main` synced to upstream, tree clean, then runs `git merge main` into `develop`.
- [ ] Read the fork's customization folder end-to-end; list what must survive.
- [ ] Enumerate all conflicts → write the analysis dossier (reason + plan per file). **Don't resolve yet.**
- [ ] Resolve bucket A (take-theirs / trivial) first.
- [ ] Resolve bucket B/C/D (fork surfaces) last, using `va-openclaw@develop` as the worked reference.
- [ ] Apply the Part-2 drift map to every touched file (grep old → retarget new).
- [ ] `pnpm tsgo && pnpm tsgo:extensions && pnpm check:test-types` → 0 errors (fix the silent cast-removal files here).
- [ ] If SDK subpaths touched: the 4 wiring points + `plugin-sdk:api:gen` + contract checks green.
- [ ] `rm pnpm-lock.yaml && pnpm install --lockfile-only` → commit the fresh lockfile.
- [ ] Commit in logical groups with `--no-verify` (merge / lockfile / type-fixes / sdk-baseline / docker).
- [ ] Operator: `docker build` → verify image boots + all fork plugins load.
- [ ] Runtime-test the fork's merge-sensitive surfaces (the ones you rewrote in bucket B/C).
- [ ] Save a project-state snapshot to remote memory before any context compaction.

---

## Appendix — what nabu-senw must discover for itself

This playbook gives you the **upstream** half (identical) and the **method** (identical). The
**fork-specific** half differs — `nabu-senw` has its own customizations (identity-file allowlist,
its own plugin set, its own gateway/Files-API and skill-token surfaces). So:

- Your **conflict set will differ** from our 48 files. Re-run Step 1 against *your* tree.
- For any surface you **share** with `va-openclaw` (the `nabu-*` plugins, deliver tool, model router,
  gateway file-refs, the SDK subpaths), our resolved files are a near-literal template — diff against them.
- For surfaces **unique to your fork**, apply the Part-3 decision framework and the Part-2 drift map;
  the upstream relocations are the same even where your hooked-in code is different.

**Verified-reference branch:** `va-openclaw@develop` (commits `2ebb959119` merge → `93ee52f8e7` docker).
Every file:line in this doc was confirmed against it on 2026-06-08.
