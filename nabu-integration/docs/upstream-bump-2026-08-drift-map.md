<!-- Pre-staged context for the 2026-08 upstream catch-up. Analysis only — nothing resolved, nothing merged.
     Companion to upstream-merge-playbook.md (method, still valid) and
     merge-conflict-resolution-plan.md (April→June drift map, now STALE — superseded by §4 below). -->

# Upstream bump 2026-08 — drift map & readiness dossier

> **Status:** preparation only. No merge started, no files resolved, working tree untouched.
> Written 2026-08-04 against `develop` @ `79369129ce`, with upstream fetched to `refs/upstream-probe/main`.

---

## 1. Ground truth

| Fact                | Value                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Fork                | `senw-developers/va-openclaw`, working branch **`develop`** (not `main`)                                    |
| `main`              | pristine mirror of upstream `openclaw/openclaw` @ `fc6400ede3` (2026-06-08)                                 |
| `develop`           | `main` + 38 fork commits; **133 files, +21,807 / −642** vs `main`                                           |
| Local version       | `openclaw 2026.6.2`                                                                                         |
| Prior merge         | base `816cd07b19` (**2026-04-08** — this is the "April" everyone means) → `fc6400ede3`. **Done and green.** |
| **Next target**     | upstream `main` @ `15499e7fc2` (2026-08-04), `openclaw 2026.7.2`                                            |
| **Drift to absorb** | **18,517 commits · 27,783 files · +5,943,741 / −1,432,015**                                                 |

Upstream npm dist-tags at time of writing: `latest 2026.7.1-2`, `extended-stable 2026.6.34`, `beta 2026.7.2-beta.7`.
Repo tip (`2026.7.2`) is ahead of `latest` — **which of these is "the new one" is an operator decision** (see §7).

For scale: the April→June hop was 28,838 commits. This one is ~64% of that — same order of magnitude, same class of work.

To reproduce the upstream ref without adding a remote:

```bash
git fetch --no-tags https://github.com/openclaw/openclaw.git main:refs/upstream-probe/main
```

---

## 2. What the fork owns

**7 bundled `nabu-*` plugins — 52 files, 3,907 LOC:**

| Plugin                             | Files |   LOC | Declares contracts                        |
| ---------------------------------- | ----: | ----: | ----------------------------------------- |
| `extensions/nabu-google-workspace` |    10 | 1,152 | —                                         |
| `extensions/nabu-model-router`     |    10 |   725 | —                                         |
| `extensions/nabu-files`            |    11 |   714 | —                                         |
| `extensions/nabu-1password`        |     9 |   415 | —                                         |
| `extensions/nabu-media-upload`     |     5 |   387 | `agentToolResultMiddleware: ["openclaw"]` |
| `extensions/nabu-email`            |     4 |   282 | —                                         |
| `extensions/nabu-gateway`          |     3 |   232 | —                                         |

**6 fork-only files inside core** (new files, not patches):
`src/gateway/chat-file-refs.ts` · `src/gateway/server-methods/dm-pairing.ts` · `src/agents/tools/deliver-tool.ts` (+`.test.ts`) · `src/plugin-sdk/media-parse.ts` · `src/plugin-sdk/media-resolver.ts` · `src/plugin-sdk/media-uploader.ts`

**31 upstream files patched in place** — enumerated in §3.

---

## 3. Collision forecast: 31 of 31

**Every single upstream file the fork patched was also changed upstream between 2026-06-08 and 2026-08-04.** There is no safe subset. Ranked by upstream churn — this is the effort map:

| File                                                  | +added | −deleted | Note                                        |
| ----------------------------------------------------- | -----: | -------: | ------------------------------------------- |
| `pnpm-lock.yaml`                                      |   8033 |     3970 | regenerate, never hand-merge                |
| `src/agents/command/attempt-execution.ts`             |   1058 |      263 | senderId chain hop                          |
| `src/agents/system-prompt.test.ts`                    |    988 |      368 | 2 fork deliver-tool cases                   |
| `extensions/feishu/src/channel.ts`                    |    587 |      131 | cast-cleanup noise → take-theirs            |
| `package.json`                                        |    542 |      441 | exports map + root deps                     |
| `src/gateway/methods/core-descriptors.ts`             |    518 |      215 | 3 `dm.pair.*` rows                          |
| `src/agents/system-prompt.ts`                         |    507 |      276 | `buildDeliverSection`                       |
| **`src/agents/embedded-agent-runner/run/attempt.ts`** |    435 | **5264** | **exploded — see §4.1**                     |
| `src/gateway/server-methods.ts`                       |    399 |      565 | lazy handler registry                       |
| `src/agents/openclaw-tools.ts`                        |    320 |      154 | deliver tool wiring                         |
| `src/gateway/server-session-events.ts`                |    285 |       85 | fileRefs enrichment                         |
| `src/gateway/openresponses-http.ts`                   |    284 |      159 | Files-API surface (hardest file last round) |
| `src/gateway/openai-http.ts`                          |    259 |      147 | senderId ingress                            |
| `docs/plugins/sdk-subpaths.md`                        |    232 |      227 | SDK wiring point 4                          |
| `src/gateway/sessions-history-http.ts`                |    209 |       80 | snapshot enrichment                         |
| `docs/.generated/plugin-sdk-api-baseline.sha256`      |    149 |        2 | regenerate                                  |
| `extensions/zai/index.ts`                             |    149 |      132 | take-theirs candidate                       |
| `src/agents/tool-catalog.ts`                          |    143 |        8 |                                             |
| `.oxlintrc.json`                                      |    140 |        4 |                                             |
| **`src/gateway/server-methods/chat.ts`**              |    125 | **4393** | **exploded — see §4.2**                     |
| `extensions/github-copilot/models.ts`                 |    125 |       41 | take-theirs candidate                       |
| `src/agents/tool-display-config.ts`                   |     93 |       16 |                                             |
| `src/agents/command/types.ts`                         |     80 |       16 | `senderId` — see §5.4                       |
| `Dockerfile`                                          |     77 |       23 |                                             |
| `src/gateway/open-responses.schema.ts`                |     47 |       38 |                                             |
| `scripts/lib/plugin-sdk-entrypoints.json`             |     33 |       45 | SDK wiring point 3                          |
| `extensions/irc/src/setup-core.ts`                    |     31 |        1 | take-theirs candidate                       |
| `.gitignore`                                          |     28 |       58 | union merge (keep `/.env`, `.mcp.json`)     |
| `src/gateway/server-runtime-config.ts`                |     10 |        1 | **deliberate divergence — §6**              |
| `src/infra/outbound/message-action-params.ts`         |      7 |        8 |                                             |
| `docker-compose.yml`                                  |      1 |        2 |                                             |

---

## 4. Structural relocations — the expensive part

Two files that host fork logic were not edited, they were **dismantled**. A conflict-marker-driven merge will not find these; you have to re-target by hand.

### 4.1 `embedded-agent-runner/run/attempt.ts` exploded (−5,264 lines)

The directory went from **65 → 165 files**. The fork's **Cloudflare AI Gateway `cf-aig-metadata` wrapper** is grafted at `attempt.ts:2698`, immediately after:

```ts
activeSession.agent.streamFn = cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
```

**That anchor no longer exists in `attempt.ts`.** The streamFn-wrapper chain now lives at `src/agents/embedded-agent-runner/extra-params.ts:837-866`, as a sequence of named provider wrappers:

```
ctx.agent.streamFn = createSiliconFlowThinkingWrapper(ctx.agent.streamFn);          // :850
ctx.agent.streamFn = createOpenRouterSystemCacheWrapper(ctx.agent.streamFn, ...);   // :860
ctx.agent.streamFn = createOpenAIStringContentWrapper(ctx.agent.streamFn);          // :861
ctx.agent.streamFn = createOpenAICompletionsStrictMessageKeysWrapper(...);          // :862
ctx.agent.streamFn = createOpenAICompletionsToolsCompatWrapper(...);                // :863
ctx.agent.streamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({...});        // :866
```

Other assignment sites: `compaction-session-agent.ts:62,80`, `compaction-session-execution.ts:290`.

> **This is an upgrade, not just a break.** Upstream now has a first-class idiom for exactly what the fork hand-grafted. The right fix is a `createCloudflareAiGatewayMetadataWrapper(...)` entry in that chain — not another inline block. It also removes the `params.model.provider → params.provider` class of breakage that bit the last merge. Recommend taking it.

### 4.2 `gateway/server-methods/chat.ts` exploded (−4,393 lines)

`server-methods/` now holds ~42 `chat-*` modules. Fork-relevant relocations:

| Was                                     | Now                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `handleChatHistoryRequest` in `chat.ts` | `src/gateway/server-methods/chat-history-handler.ts`                                                      |
| projection helpers                      | `src/gateway/chat-display-projection.ts` / `.core.ts`                                                     |
| projection call sites                   | `chat-broadcast.ts`, `chat-history-pages.ts`, `chat-message-get-handler.ts`, `chat-send-reply-context.ts` |

The fork's `enrichMessagesWithFileRefs` must still run **before** `projectRecentChatDisplayMessages` (projection deletes `details`, which is where `details.nabuFileIds` lives). That ordering invariant now has to be re-established across a split module set — see §5.1.

---

## 5. Seam verification against the new tip

Everything below was checked directly against `refs/upstream-probe/main`.

### 5.1 Holding — no action beyond re-graft

- **All 6 upstream plugin-SDK subpaths the nabu plugins import still exist and are still exported**: `agent-harness`, `channel-actions`, `error-runtime`, `media-mime`, `plugin-entry`, `secret-ref-runtime`. The public contract held.
- `src/media/parse.ts` survives. `src/media/mime.ts` is **gone**, but the fork already retargeted to `@openclaw/media-core/mime` last round — no action.
- `typebox` is still bare `typebox` (1.3.6). No repeat of the `@sinclair/typebox` rename.
- `handleTranscriptUpdateBroadcast` **survives** in `server-session-events.ts`; the fork's `enrichMessageWithFileRefs` graft just shifts (`projectChatDisplayMessage` :366, `broadcastToConnIds` :368). _Note: the playbook's `createMessageEventBroadcastHandler` name is stale — that symbol no longer exists._
- All 16 other fork graft-host files still exist at their paths.

### 5.2 Changed — `AgentToolResultMiddleware`

The contract `nabu-media-upload` declares was edited (+7/−8):

- **Removed:** `AgentToolResultMiddlewareHarness` type, deprecated `harness?` field, deprecated `harnesses?` option.
- **Added:** `matcher?: PluginToolMatcher` on options; new `AgentToolResultMiddlewareScope` type.

**Impact: none breaking.** `extensions/nabu-media-upload/index.ts:14` uses `runtimes: ["openclaw"]`, which survives; no fork code references any removed name (verified by grep across all fork surfaces).

> **Opportunity:** the new declarative `matcher` could replace the plugin's manual `BUILT_IN_PI_TOOLS` short-circuit.

### 5.3 Stale playbook reference

`extensions/tokenjuice/src/tool-result-middleware.ts` — cited by the playbook as the adapter template — **no longer exists**. Pick a current middleware implementation as the template instead.

### 5.4 `senderId` — fork patch still required, but converging

Upstream **still has no `senderId` on `AgentCommandOpts`**, so the fork's patch at `src/agents/command/types.ts:85+` must be re-applied.

However, upstream has independently added `senderId?: string | null` to **`AgentRunContext`** (`types.ts:52`) — a different type, and note the nullability differs from the fork's `senderId?: string`. Whether the fork's identity chain should now ride upstream's field instead of its own is a real design question, not a mechanical one → §7.

### 5.5 Fork-only SDK subpaths — no collision

`media-parse`, `media-resolver`, `media-uploader` remain fork-only and need all **4 wiring points** re-applied (`src/plugin-sdk/<name>.ts`, `package.json` exports, `scripts/lib/plugin-sdk-entrypoints.json`, `docs/plugins/sdk-subpaths.md`) plus `pnpm plugin-sdk:api:gen`.

Upstream's media SDK surface grew a lot — `agent-media-payload`, `outbound-media`, `media-runtime`, `media-local-roots`, `media-store`, `web-media` — but **none collide by name** with the fork's three.

### 5.6 Upstream has NOT absorbed fork features

Checked and confirmed absent upstream: a `deliver` tool, `chat-file-refs`-equivalent, `getMediaUploader`/`MediaUploadResult`, `dm.pair.*` RPCs. **The fork keeps owning all of it** — no deletion shortcut available.

But upstream grew _adjacent_ subsystems worth comparing against before re-grafting:

- **Attachments:** `chat-attachments.ts`, `chat-attachment-policy.ts`, `managed-image-attachments.ts`, `server-methods/attachment-normalize.ts`, `chat-send-attachments.ts` — overlaps the fork's `chat-file-refs.ts` + `USER_ATTACHMENT_CUSTOM_TYPE`.
- **Pairing:** `channel-pairing.ts`, `device-pair-setup.ts`, `nodes.pairing.ts` — overlaps the fork's `dm-pairing.ts`.

---

## 6. Deliberate divergence to protect

`src/gateway/server-runtime-config.ts` — the fork **intentionally disables** the non-loopback Control-UI origin guard for containerized/reverse-proxied deploys. Upstream churn here is small (+10/−1), which makes it _more_ likely to be silently swallowed by an "accept theirs". This is a security control being deliberately weakened; it must be re-applied consciously or explicitly reversed — never by default.

---

## 7. Open questions for the operator

1. **What is "the new one"?** Repo tip `2026.7.2` (18,517 commits) vs npm `latest 2026.7.1-2` vs `extended-stable 2026.6.34`. Different targets, materially different drift.
2. **Is the April→June merge deployed?** `develop` carries a completed, green June-08 merge. If the running image predates it, the first move may be to ship _that_ and bump from a known-good base — rather than stacking two upstream hops into one merge.
3. **Cloudflare wrapper:** adopt upstream's `extra-params.ts` wrapper-chain idiom (recommended, §4.1) or re-graft inline?
4. **`senderId`:** keep the fork's `AgentCommandOpts.senderId`, or migrate the chain onto upstream's new `AgentRunContext.senderId` (`string | null`)? (§5.4)
5. **Attachments/pairing convergence:** re-graft fork subsystems as-is, or re-express on upstream's new attachment/pairing surfaces? (§5.6)
6. **`matcher` adoption** for `nabu-media-upload` in place of manual tool filtering? (§5.2)
7. **Control-UI guard:** still required, or configure `gateway.controlUi.allowedOrigins` properly this time? (§6)

---

## 8. Verification gates

Unchanged from `upstream-merge-playbook.md` §4 — that method is still valid. Confirm each script still exists in the merged `package.json` before relying on it:

```bash
pnpm tsgo && pnpm tsgo:extensions && pnpm check:test-types   # all three — core-only is not enough
pnpm plugin-sdk:check-exports && pnpm lint:plugins:plugin-sdk-subpaths-exported && pnpm plugin-sdk:api:check
rm pnpm-lock.yaml && pnpm install --lockfile-only
DOCKER_BUILDKIT=1 docker build -t openclaw:local .
```

Traps that still apply: `build:docker` does not typecheck; the silent cast-removal trap only surfaces in the extensions/test tsgo lanes; a contract-declaring plugin shows "disabled" in `plugins list` but still fires.
