<!-- Generated for the upstream-merge of openclaw into the nabu fork.
     base (merge-base) = 816cd07b19 ; incoming MERGE_HEAD = fc6400ede3 (main, +28,838 commits)
     48 conflicted files. This plan was produced by a 23-agent analysis and hand-verified. -->

# NABU FORK — UPSTREAM MERGE CONFLICT RESOLUTION PLAN

> **Status:** analysis only. No conflicts have been resolved. base=`816cd07b19`, incoming=`fc6400ede3` (`main`).
> **Counts (structured):** 24 take-theirs · 11 reapply-nabu-onto-upstream · 8 manual-merge · 1 regenerate · 1 delete-ours. Risk: 2 high · 10 medium · 33 low.

## 0. Verified amplifications (hand-checked after the agent pass)

These four facts were confirmed directly against the git index/trees and refine the plan below:

1. **`src/media/` was partially extracted into a new package `@openclaw/media-core` (`packages/media-core/`).** The whole dir is NOT deleted (59 files remain in `MERGE_HEAD`), but several files moved out, including `src/media/mime.ts`. This is NOT one of the 48 conflicts — it is a **silent post-merge build break** because nabu imports the moved files. Retarget exactly these import sites:
   - `src/gateway/openresponses-http.ts:15` — `extensionForMime` from `../media/mime.js` → **`@openclaw/media-core/mime`**.
   - `src/agents/agent-hooks/media-upload/extension.ts:7` — `detectMime` from `../../../media/mime.js` → **`@openclaw/media-core/mime`**.
   - `extension.ts:8` `splitMediaFromOutput` from `../../../media/parse.js` — **no change** (`src/media/parse.ts` survives upstream).
   - Both `detectMime` and `extensionForMime` are confirmed exported from `packages/media-core/src/mime.ts`.
2. **The `media-upload` "add/add" is really a directory-rename follow.** Nabu's files lived at `src/agents/pi-hooks/media-upload*`; upstream renamed `pi-hooks/ → agent-hooks/`, so git relocated nabu's files to `src/agents/agent-hooks/media-upload*` and staged them `AU` (added-by-us), deleting the old `pi-hooks/` paths. There is **no upstream media-upload implementation** — only the registration seam (`api.on("tool_result")`) is gone, replaced by upstream's `AgentToolResultMiddleware`. See §3 + §7.1.
3. **The `openresponses-http.ts` streaming block at ~L1259-1357 auto-merged with NO conflict markers** but is still nabu's single-tool-call (`pendingToolCalls[0]`) version — it must be manually upgraded to upstream's multi-tool-call loop or multi-tool turns silently regress. See §3 (openresponses-http) step 6 + §7.2.
4. **`extensions/qa-lab/src/bus-state.ts`:** nabu's edit was an *incorrect* type narrowing (dropped 5 valid seed kinds). take-theirs is mandatory, not cosmetic.

---

# NABU MERGE — CONFLICT RESOLUTION PLAN

## 1. Summary

**Total conflicts: 48 files.** Breakdown:

- **8 high-risk / manual-merge** (require careful hand-editing): `src/gateway/openresponses-http.ts` (hard), `src/gateway/server.impl.ts`, `src/gateway/server-runtime-config.ts`, `src/gateway/openai-http.ts`, `src/agents/command/types.ts`, `src/agents/system-prompt.test.ts`, `src/infra/outbound/message-action-params.ts`, plus the `media-upload` add-add collision (hard).
- **6 reapply-onto-upstream** structural files where the nabu delta is small but lands inside an upstream rewrite: `src/gateway/server-methods.ts`, `src/gateway/server-methods/chat.ts`, `src/gateway/sessions-history-http.ts`, `src/gateway/method-scopes.ts`, `src/gateway/server-methods-list.ts`, `src/agents/openclaw-tools.ts`, `src/agents/system-prompt.ts`, `docs/plugins/sdk-overview.md` (and the `pi-embedded-runner` modify/delete pair).
- **~23 take-theirs-trivial** extension files (cast-cleanup noise overlapping upstream refactors): all of `ext-batch-channels`, `ext-batch-telegram`, `ext-batch-search-providers`, `ext-batch-misc` (one of which, `extensions/speech-core/src/tts.ts`, is a `delete-ours` modify/delete).
- **5 build/config**: `package.json`, `tsdown.config.ts`, `docker-compose.yml`, `.gitignore`, and `pnpm-lock.yaml` (regenerate).

**Overall difficulty: moderate.** The volume is dominated by trivial take-theirs cast-cleanup churn; the real risk concentrates in ~3 hard files (`openresponses-http.ts`, the `media-upload` middleware re-expression, and the `pi-embedded-runner` rename plumbing), all of which carry the nabu Files-API surface that has no upstream equivalent and must be re-expressed onto upstream's renamed/refactored structure.

---

## 2. Resolution Order

Resolve in this sequence to shrink the surface progressively and avoid rework:

1. **Trivial take-theirs batch first** (all `ext-batch-*` + `tsdown.config.ts` + `docker-compose.yml` + `extensions/speech-core/src/tts.ts` delete). These are pure noise overlaps; clearing them removes ~24 files from the working tree's conflict set with near-zero thought, leaving only files that actually carry nabu logic. *Justification: maximizes signal-to-noise before the hard work.*
2. **Build/config (`package.json`, `.gitignore`) next, defer `pnpm-lock.yaml`.** `package.json` must be settled before the lockfile can be regenerated, and its dep decisions (drop root `nostr-tools`/`zca-js`) are independent of the gateway/agents work. *Justification: lockfile regen is the last gate and depends on every `package.json`.*
3. **Hard gateway/agents files.** Resolve the descriptor/registration cross-file family together (`method-scopes.ts` + `server-methods.ts` + `server-methods-list.ts` + `core-descriptors.ts`) since they share one re-apply target, then `server.impl.ts`/`chat.ts`/`sessions-history-http.ts` (all depend on the nabu-only `chat-file-refs.ts`), then the agent prompt/tool files (`system-prompt.ts` **before** `system-prompt.test.ts`, since the test follows the section), then `openresponses-http.ts` and `openai-http.ts` (shared `senderId` plumbing). *Justification: these need the descriptor/file-refs seams understood once and applied consistently.*
4. **Media-upload collision + modify/deletes last.** The `media-upload` add-add and the `pi-embedded-runner` modify/delete need a design decision (Path A bundled-plugin vs Path B core-internal middleware) and depend on `src/media/mime.ts` being kept. Do these after the rest so the design choice is made with full context. *Justification: they require design thought, not mechanical resolution.*
5. **`pnpm-lock.yaml` regenerate** via `pnpm install` once all `package.json` files are final.

---

## 3. High-Risk / Manual-Merge Files

### `src/gateway/openresponses-http.ts` — content (hard, **high risk**)

- **Conflicts because:** both sides edited the same six regions vs base `816cd07b19`. Ours added the nabu Files-API + inline-media layer (`joinPayloadsWithMedia`, `resolveTurnFileRefs`, `uploadInboundImage`, `appendUserAttachmentEntryToSession`, `senderIsOwner`/`senderId` threading, `createDefaultDeps`-return deps type, `let fileContexts`, `inboundUploadedFileIds`); theirs removed `senderIsOwner` gating, retyped deps to `CliDeps` (`cli/deps.types.js`), renamed the runner import to `../agents/embedded-agent-runner/run/params.js`, added `resolveIntegerOption` from `@openclaw/normalization-core/number-coercion`, added `isClientToolNameConflictError`, and rewrote **both** tool-call emission blocks into a multi-call loop (one `function_call` item per pending call, `2584d0d415`).
- **Nabu logic that must survive:** `joinPayloadsWithMedia`, `resolveTurnFileRefs` + `appendUserAttachmentEntryToSession` + `USER_ATTACHMENT_CUSTOM_TYPE`, `uploadInboundImage`/`getMediaUploader`, `stripMarkdownImages` + `fileRefs` on `response.completed`, and the `senderId` (OpenAI `user` → `requesterSenderId`) plumbing. **Drop `senderIsOwner`** — it predates the fork and upstream deliberately removed it; nabu only forwards it, no gating use.
- **Plan (manual, hunk-by-hunk, upstream as spine):**
  1. **Hunk1 (imports):** UNION — keep theirs (`resolveIntegerOption`, `isClientToolNameConflictError`, `ImageContent`) AND ours nabu imports, but **retarget** the runner import to `../agents/embedded-agent-runner/run/params.js` (drop the stale `pi-embedded-runner` line). Keep `node:path`, `SessionManager` (`@mariozechner/pi-coding-agent`), `extensionForMime`, `getMediaUploader`/`MediaUploadResult`, `resolveSessionFilePath`.
  2. **Hunk2 (params):** take theirs `deps: CliDeps`; KEEP ours `senderId?: string`; DROP `senderIsOwner: boolean`.
  3. **Hunk3:** take ours `let fileContexts: string[] = []` + `const inboundUploadedFileIds: number[] = []`.
  4. **Hunk4 + Hunk6 (call sites):** take theirs base, re-add only `senderId: user?.trim() || undefined,` (no `senderIsOwner`).
  5. **Hunk5 (non-stream tool_calls):** take **theirs** multi-call loop, but swap its `assistantText` to nabu's `joinPayloadsWithMedia(payloads)`.
  6. **CRITICAL:** the streaming tool block (~L1180) auto-merged as ours' single-call version with **no conflict markers** — it must still be manually upgraded to the multi-call loop, and its finalize text changed to `accumulatedText || joinPayloadsWithMedia(resultAny.payloads)`, or multi-tool turns regress.
  7. Preserve `const content = joinPayloadsWithMedia(payloads) || 'No response from OpenClaw.'`, `resolveTurnFileRefs(sessionKey, inboundUploadedFileIds)`, `stripMarkdownImages` when `turnFileRefs>0`, `fileRefs: turnFileRefs` on `createResponseResource`, and `appendUserAttachmentEntryToSession(...)` after the agent call.
  8. Build to verify `embedded-agent-runner` path, `normalization-core`, `getMediaUploader`, `SessionManager` resolve; run scoped gateway tests.

### `src/gateway/server.impl.ts` — content (moderate, medium risk)

- **Conflicts because:** ours (commit `67de177891`) added `import { enrichMessageWithFileRefs } from "./chat-file-refs.js";` and wrapped the inline `onSessionTranscriptUpdate` `broadcastToConnIds("session.message", ...)` in a `void (async () => { const enriched = await enrichMessageWithFileRefs(...); ... })()`. Theirs extracted that entire ~450-line inline subscription block out of `server.impl.ts` into `startGatewayEventSubscriptions` (`server-runtime-subscriptions.ts`) and moved the broadcast into `createMessageEventBroadcastHandler` (`server-session-events.ts`). The nabu change targets code that no longer exists in this file.
- **Nabu logic that must survive:** the `session.message` enrichment via `enrichMessageWithFileRefs` so nabu file-attachment refs (`nabu-file-attachment`) reach live subscribers. The supporting `src/gateway/chat-file-refs.ts` is nabu-only and **not** in conflict.
- **Plan (reapply onto upstream's relocated file):**
  1. Conflict 1 (L59-66): take upstream's import block (`ADMIN_SCOPE` from `./method-scopes.js` etc.); **drop** the nabu `chat-file-refs.js` import from `server.impl.ts` (call site moved).
  2. Conflict 2 (L1115-1577): take upstream wholesale (`startGatewayEventSubscriptions`/`startGatewayRuntimeServices`); discard the entire nabu inline block.
  3. **Re-apply** in `src/gateway/server-session-events.ts` `createMessageEventBroadcastHandler` (~L187-207): add `import { enrichMessageWithFileRefs } from "./chat-file-refs.js";`, and wrap upstream's `const message = projectChatDisplayMessage(rawMessage); if (message) { params.broadcastToConnIds("session.message", { ..., message, ... }, connIds, { dropIfSlow: true }); return; }` with `void (async () => { const enriched = await enrichMessageWithFileRefs(message, { requestId: \`session.message:${sessionKey}\` }); params.broadcastToConnIds("session.message", { ..., message: enriched, ... }, connIds, { dropIfSlow: true }); })();` — preserving upstream's new `agentId`/`visibleAgentId`/`sessionSnapshot` fields and the `if (message)` guard.
  4. Confirm `chat-file-refs.ts` is present in the merged tree; build + run `src/gateway/session-message-events.test.ts`.

### `src/gateway/server-runtime-config.ts` — content (moderate, medium risk)

- **Conflicts because:** ours (commit `a8cf9eae00`) commented out the non-loopback Control UI origin guard (both the `controlUiAllowedOrigins`/`dangerouslyAllowHostHeaderOriginFallback` declarations AND the `if (controlUiEnabled && !isLoopbackHost(bindHost) && ... === 0 && ...) throw` block). Theirs kept the guard live and only added an explanatory comment, while broadly rewriting the module (new imports `OpenClawConfig`/`types.gateway.js`, `warnLegacyOpenClawEnvVars`, `gateway-tailscale-auth-policy`, removed `canvasHostEnabled`, added `isUnsafeGatewayTailscaleNoAuth` guard).
- **Cross-hunk hazard:** the two variable **declarations** (L136-140) auto-merged to ours' commented-out form (outside the conflict), but the upstream side of the conflict hunk **references** them — naive take-theirs yields undeclared identifiers.
- **Nabu logic that must survive:** disabling the non-loopback Control UI `allowedOrigins` guard (for containerized / reverse-proxied non-loopback bind). This is a security control nabu intentionally weakens — flag to operator, but preserve.
- **Plan (manual):**
  1. Start from upstream's whole file (keep all new imports, removed `canvasHostEnabled`, new `isUnsafeGatewayTailscaleNoAuth` guard, extended error message).
  2. Re-apply nabu: comment out **or delete** both the two declarations and the matching guard block (recommended: delete, since the intent is permanent — avoids dead commented code). Keep declarations and usage in the **same** state to avoid dangling references.
  3. Resolve the marker by choosing the HEAD (disabled) side, delete markers.
  4. Verify 0 live references to `controlUiAllowedOrigins`/`dangerouslyAllowHostHeaderOriginFallback`, and that `src/gateway/env-deprecation.ts` + `src/shared/gateway-tailscale-auth-policy.ts` are staged from the merge.
  5. `pnpm tsgo`/`pnpm build` to confirm no TS2304 and no missing-module errors.

### `src/gateway/openai-http.ts` — content (trivial effort, low risk)

- **Conflicts because:** ours (commit `9e135943cf`) threaded the OpenAI `user` body field into `buildAgentCommandInput` as `senderId` alongside the existing `senderIsOwner`. Theirs rewrote the endpoint (663→1385 LOC: client tool-calling, `tool_choice`, sampling/`streamParams`) and removed `senderIsOwner` from this endpoint's param type, returned object, and call site.
- **Nabu logic that must survive:** `senderId` ingress (`senderId: user?.trim() || undefined`) so it reaches `OpenClawPluginToolContext.requesterSenderId` for the nabu Google Workspace plugin. `senderIsOwner` removal here is upstream's intent — honor it.
- **Plan (manual):**
  1. Hunk1 (param type, ~L154-163): keep nabu's `senderId?: string;` + theirs' `abortSignal?`/`streamParams?`; drop `senderIsOwner: boolean`.
  2. Hunk2 (call site, ~L1060-1065): keep nabu's `senderId: user?.trim() || undefined,` AND theirs' `streamParams,`; drop `senderIsOwner,`.
  3. Verify the already-merged return object (~L177) still has `senderId: params.senderId` and no `senderIsOwner`; remove any orphaned `senderIsOwner`/`resolveOpenAiCompatibleHttpSenderIsOwner` references.
  4. `pnpm tsgo`.

### `src/agents/command/types.ts` — content (trivial effort, low risk)

- **Conflicts because:** ours (commit `9e135943cf`) inserted `senderId?: string` into `AgentCommandOpts` between `channel?` and the `accountId` comment; theirs rewrote that exact region (split `channel`, inserted `messageProvider?`, reworded comments, moved `AgentStreamParams`/`ClientToolDefinition` to `./shared-types.js`, added many new fields).
- **Nabu logic that must survive:** `senderId?: string` on `AgentCommandOpts` — the entry point of the trusted-end-user-identity chain (→ `attempt-execution.ts` → embedded runner → `requesterSenderId`, read at `extensions/nabu-google-workspace/src/tools/nabu-google.tool.ts:138`). Upstream's `requesterSenderId` plumbing never reaches `AgentCommandOpts`, so this field is still required.
- **Plan (manual):**
  1. Resolve the hunk (~L84-100) to upstream's side (`messageProvider?: string;`, `channel?: string;`, `/** Account ID ... */`).
  2. Insert nabu's doc comment + `senderId?: string;` immediately after the `channel?: string;` line.
  3. Do NOT reintroduce ours' local `AgentStreamParams` or the old `ClientToolDefinition` import path.
  4. Confirm the sibling `src/agents/command/attempt-execution.ts` merge re-applies `senderId: params.opts.senderId` (separate conflict, same chain — must land together).

### `src/agents/system-prompt.test.ts` — content (moderate, medium risk)

- **Conflicts because:** ours (commit `bb15c70a64`) appended two `it()` cases asserting the `## Delivering Files` section and that it sits before `SYSTEM_PROMPT_CACHE_BOUNDARY`. Theirs rewrote the file wholesale and inserted a new "keeps stable project context before volatile channel guidance" test plus new `buildAgentBootstrapSystemContext`/`buildAgentBootstrapSystemPromptSections` describe blocks at the same tail anchor.
- **Nabu logic that must survive:** the two deliver-tool test cases — the only coverage proving `buildDeliverSection` renders only when `deliver` is available and non-minimal, and stays in the prompt-cache-stable prefix.
- **Plan (manual):**
  1. Keep theirs as base (imports already auto-merged to upstream; do not re-add `subagent-announce.js`).
  2. In the conflict hunk: take the **entire main side verbatim** (prefix-cache test, closing `});`, the two new bootstrap describe blocks).
  3. Re-insert nabu's two `it()` blocks as the last two tests **inside** `describe("buildAgentSystemPrompt")`, before its closing `});` (they need only `buildAgentSystemPrompt` + `SYSTEM_PROMPT_CACHE_BOUNDARY`, already imported).
  4. **Resolve `src/agents/system-prompt.ts` first** (keep `buildDeliverSection`) — this test only passes if that section exists and is wired before the cache boundary.
  5. Run `pnpm test src/agents/system-prompt.test.ts`.

### `src/infra/outbound/message-action-params.ts` — content (moderate, medium risk)

- **Conflicts because:** both sides edited the same two `mediaLocalRoots:`/`mediaReadFile:` property lines in the single `resolveOutboundMediaAccess({...})` call. Ours (commit `67de177891`) wrapped `mediaReadFile` with `wrapReadFileForHttpUrls(params.mediaReadFile)`; theirs introduced `explicitLocalRoots` (`readonly string[] | "any"`) and a readFile dedup guard `params.mediaAccess?.readFile ? undefined : params.mediaReadFile`. Git auto-merged the surrounding additions (including the full `wrapReadFileForHttpUrls` function body) cleanly; only the 2 property lines conflict.
- **Nabu logic that must survive:** the call site `mediaReadFile: wrapReadFileForHttpUrls(...)` so `http(s)://` sources routed through the host readFile seam are fetched. (Note: a belt-and-suspenders seam — `loadWebMedia` already fetches `http(s)://` mediaUrls first.)
- **Plan (compose both):** replace the conflict block with:
  - `mediaLocalRoots: explicitLocalRoots === "any" ? undefined : explicitLocalRoots,` (take theirs verbatim — nabu never intentionally changed this).
  - `mediaReadFile: params.mediaAccess?.readFile ? undefined : wrapReadFileForHttpUrls(params.mediaReadFile),` (theirs' dedup guard wrapping nabu's helper).
  - Keep everything Git already merged (the `explicitLocalRoots` const, the two trailing spread props, the `wrapReadFileForHttpUrls` definition). Do NOT touch the trailing-spread `mediaReadFile`. Confirm `wrapReadFileForHttpUrls` is defined exactly once. Optional follow-up: evaluate whether the wrapper is dead code given `loadWebMedia` — not required for a behavior-preserving merge.

### `src/agents/agent-hooks/media-upload` (add-add collision) — hard, **high risk**

- **Conflicts because:** the task premise (upstream added a `media-upload/` directory) is **wrong**. The three blobs are nabu's net-new files (originally `src/agents/pi-hooks/media-upload*`); git's directory-rename detection followed upstream's `pi-hooks/ → agent-hooks/` rename and relocated them, leaving them at stage-2-only (`AU`). The real semantic conflict is the registration site: nabu's `factories.push(mediaUploadExtension)` (old `api.on("tool_result")` pi-extension shape) has no home in upstream's rewritten extensions file. Upstream replaced that seam with a first-class tool-result middleware system (`AgentToolResultMiddleware`/`AgentToolResultMiddlewareEvent` in `src/plugins/agent-tool-result-middleware-types.ts`, `buildAgentToolResultMiddlewareFactory()` in `embedded-agent-runner/extensions.ts`, SDK surface `src/plugin-sdk/agent-harness-runtime.ts`, manifest contract `contracts.agentToolResultMiddleware`).
- **Nabu logic that must survive:** the Files-API delivery pipeline — on each tool result, upload local/MiniMax-CDN media via `getMediaUploader`, stamp both `details.nabuFileIds` (web fileRefs) and `details.media.mediaUrls` (channel delivery), strip `MEDIA:` markers from model-visible prose, append the URL-free "N files delivered, do not regenerate" confirmation; plus `deliver`-tool `details.deliverables[].path` handling and the `MINIMAX_CDN_RE` allowlist.
- **Plan (re-express as upstream middleware):**
  1. Keep the implementation under the renamed tree: `src/agents/agent-hooks/media-upload/extension.ts` + `extension.test.ts`; the `media-upload.ts` barrel can stay or be inlined.
  2. Rewrite the signature: replace `@mariozechner/pi-coding-agent` `ExtensionAPI`/`ToolResultEvent` types with `AgentToolResultMiddleware`/`AgentToolResultMiddlewareEvent`/`OpenClawAgentToolResult`. Map `event.content`→`event.result.content`, `event.details`→`event.result.details`; return `{ result: { content, details } }` (host recomputes `isError`). The `BUILT_IN_PI_TOOLS` short-circuit, candidate collection, upload-with-timeout, and rewriteContent/rewriteDetails bodies port essentially unchanged.
  3. **Registration — pick one (open design question, §7):**
     - **Path A (recommended, core stays extension-agnostic):** make it a bundled plugin like `extensions/tokenjuice/` — `contracts.agentToolResultMiddleware: ["openclaw"]` in `openclaw.plugin.json`, and `register(api){ api.registerAgentToolResultMiddleware(createMediaUploadMiddleware(), { runtimes: ["openclaw"] }); }`. Use tokenjuice's `tool-result-middleware.ts` as the adapter template.
     - **Path B (faster, lower-churn):** register the middleware directly in `buildAgentToolResultMiddlewareFactory()` in `src/agents/embedded-agent-runner/extensions.ts`, dropping nabu's `factories.push(...)` line.
  4. **Dependency check:** `getMediaUploader`/`MediaUploadResult` (`src/plugin-sdk/media-uploader.ts`, nabu-only, present), `splitMediaFromOutput` (`src/media/parse.ts`, survives), `withTimeout` (`src/utils/with-timeout.ts`, survives), and `detectMime` (`src/media/mime.ts`, currently shows `D` — **must be resolved to keep nabu's `mime.ts`** before this compiles).
  5. Port `extension.test.ts` to drive an `AgentToolResultMiddlewareEvent` and assert on returned `result.details.nabuFileIds` / `result.details.media.mediaUrls` / the appended confirmation. If it becomes a bundled plugin, move the test under that package per the extension-test boundary rule.

### `src/agents/pi-embedded-runner/{run/attempt.ts, extensions.ts}` — modify/delete (moderate, low risk)

- **Conflicts because:** upstream commit `bb46b79d3c` renamed `pi-embedded-runner/** → embedded-agent-runner/**` and `pi-hooks/** → agent-hooks/**`. Git reports the fork-modified old paths as `UD`; the equivalent code lives at the renamed paths where the nabu insertion anchors still exist verbatim.
- **Nabu logic that must survive:** (1) the Cloudflare AI Gateway streamFn wrapper (injects `cf-aig-metadata` `responseId=runId`, `environment=NABU_ENVIRONMENT`) for `cloudflare-ai-gateway`; (2) registration of the nabu media-upload hook into the extension factory chain.
- **Plan (reapply onto renamed files):**
  1. Accept deletion of the old `pi-embedded-runner` paths (the renamed files arrive as clean adds).
  2. In `src/agents/embedded-agent-runner/extensions.ts`: add `import mediaUploadExtension from "../agent-hooks/media-upload.js";` (note `../agent-hooks/`, NOT `../pi-hooks/`) and `factories.push(mediaUploadExtension);` before `return factories;`. *(If §7 resolves media-upload to a bundled plugin — Path A — this `factories.push` is replaced by plugin registration instead.)*
  3. In `src/agents/embedded-agent-runner/run/attempt.ts`: re-insert the ~33-line Cloudflare block verbatim immediately after the `if (cacheTrace) { ... activeSession.agent.streamFn = cacheTrace.wrapStreamFn(...) }` block (~L2698) and before the "Anthropic Claude endpoints can reject replayed thinking blocks" comment. No symbol changes needed (`params.runId`, `params.model.provider`, `(model, context, options)`/`options.headers` all present upstream).
  4. Keep the `AU`-staged `agent-hooks/media-upload*` files; drop the old `pi-hooks/media-upload*` deletions. `pnpm tsgo`/`pnpm build`.

---

### Reapply-onto-upstream structural files (lower-risk than above but still hand-edited)

| File | Conflict | Nabu logic at stake | Resolution |
|---|---|---|---|
| `src/gateway/server-methods.ts` | ours added static `import { dmPairingHandlers }` (`.ts` ext) + `...dmPairingHandlers` spread; theirs rewrote to lazy descriptor registry | DM-pairing RPCs `dm.pair.list/approve/reject` | Take theirs both regions. Add `const loadDmPairingHandlers = lazyHandlerModule(() => import("./server-methods/dm-pairing.js"), (m) => m.dmPairingHandlers);` (fix `.ts`→`.js`). Add `...createLazyCoreHandlers({ methods: ["dm.pair.list","dm.pair.approve","dm.pair.reject"], loadHandlers: loadDmPairingHandlers }),` near device/connect entries. Add 3 `{ name, scope: "operator.pairing" }` descriptors to `core-descriptors.ts`. `pnpm build` (watch `[INEFFECTIVE_DYNAMIC_IMPORT]`). |
| `src/gateway/server-methods/chat.ts` | ours added Files-API enrichment to inline `chat.history`; theirs extracted `handleChatHistoryRequest`, switched to async reads, and projection now does `delete entry.details` | `enrichMessagesWithFileRefs` + `readUserAttachmentFileIdsByMessage` must run **before** `projectRecentChatDisplayMessages` (which strips `details.nabuFileIds`) | Take theirs both hunks (hunk2 was mis-stitched into `chat.message.get` — discard ours). Add `import { enrichMessagesWithFileRefs, readUserAttachmentFileIdsByMessage } from "../chat-file-refs.js";`. In `handleChatHistoryRequest`, insert enrichment between `recencyFilteredMessages` and `projectRecentChatDisplayMessages(...)`, passing the enriched array. Naturally extends to `chat.startup` (intentional). |
| `src/gateway/sessions-history-http.ts` | ours added enrichment on sync `readSessionMessages`; theirs rewrote to async bounded/full reads + re-auth SSE; auto-merged tail left a dangling `enrichedSnapshot` ref | Files-API enrichment on the JSON snapshot path | Take theirs whole file. Add `import { resolveSessionFilePath } from "../config/sessions/paths.js";`, the two `chat-file-refs.js` imports, and re-add `import path from "node:path";`. After upstream's `rawSnapshot`, insert `userAttachments`/`enrichedSnapshot`; pass `rawMessages: enrichedSnapshot` while keeping `rawTranscriptSeq`/`totalRawMessages`. SSE stays on un-enriched `rawSnapshot`. Drop the webchat `chatHistoryMaxChars` override (base behavior, not nabu). |
| `src/gateway/method-scopes.ts` | ours added `dm.pair.*` to `PAIRING_SCOPE`; theirs deleted the inline scope tables, relocating to `core-descriptors.ts` | `dm.pair.*` → `operator.pairing` (else falls back to `ADMIN_SCOPE`, breaking pairing auth) | Take theirs (delete the whole inline block). Re-apply the 3 descriptors in `core-descriptors.ts` (same as `server-methods.ts` step). |
| `src/gateway/server-methods-list.ts` | ours appended `dm.pair.*` to `BASE_METHODS`; theirs deleted `BASE_METHODS`, deriving from `CORE_GATEWAY_METHOD_SPECS` | `dm.pair.*` must remain advertised by `listGatewayMethods()` | Take theirs (delete fenced `BASE_METHODS`). Re-add via the 3 descriptors in `core-descriptors.ts` (advertises + scopes them). Drop the now-redundant `method-scopes.ts` lines. |
| `src/agents/openclaw-tools.ts` | ours added `createDeliverTool` import + construction + array entry; theirs rewrote the file (media-tool gating, `collectPresentOpenClawTools`, before-tool-call hooks) | the `deliver` tool wiring (import, `createDeliverTool({ config, workspaceDir })`, array inclusion) | Take theirs all 3 hunks. Re-add `import { createDeliverTool } from "./tools/deliver-tool.js";`, `const deliverTool = createDeliverTool({ config: options?.config, workspaceDir });` among theirs' media constructors, and include in `...collectPresentOpenClawTools([imageGenerateTool, deliverTool, musicGenerateTool, videoGenerateTool])`. Auto-wrapped by `wrapToolWithBeforeToolCallHook` (desirable). |
| `src/agents/system-prompt.ts` | ours added `buildDeliverSection` ("## Delivering Files"); theirs rewrote the file and inserted `buildWebchatCanvasSection` at the same anchor | `buildDeliverSection` + its call site (gated on `availableTools.has("deliver")`) | Take theirs at the marker (keep `buildWebchatCanvasSection`). Re-add the `buildDeliverSection` function (next to `buildVoiceSection`) and `...buildDeliverSection({ isMinimal, availableTools }),` immediately before `...buildVoiceSection(...)`. Confirm exactly one definition + one call. |
| `docs/plugins/sdk-overview.md` | ours added 2 SDK-subpath rows to the inline catalog; theirs deleted the catalog and relocated it to a new `docs/plugins/sdk-subpaths.md` | doc rows for `plugin-sdk/media-uploader` and `plugin-sdk/media-resolver` | Take theirs in this file (delete the inline catalog). Re-add the two rows to the "Capability and testing subpaths" table in `docs/plugins/sdk-subpaths.md`, after `media-generation-runtime`. Verify the companion `scripts/lib/plugin-sdk-entrypoints.json` conflict re-adds both real subpaths. |

---

## 4. Take-Theirs (Trivial) Table

All rows are cast-cleanup or no-op noise from nabu commits `7790aa0469` / `4c0bc3a83d` that overlap genuine upstream refactors. **Resolution for every row: accept the full `>>>>>>> main` side; discard HEAD.** No nabu logic to re-apply.

| Path | What ours did | Nabu-irrelevant? | Plan note |
|---|---|---|---|
| `extensions/discord/src/accounts.ts` | dropped `as DiscordAccountConfig \| undefined` cast | confirmed | take-theirs (`const merged = ...`, `tokenStatus`) |
| `extensions/slack/src/accounts.ts` | dropped `as SlackAccountConfig \| undefined` cast | confirmed | take-theirs (`resolveSlackAccountConfig`, streaming merge) |
| `extensions/whatsapp/src/account-config.ts` | dropped `as WhatsAppAccountConfig \| undefined` cast | confirmed | take-theirs (`const base = ...` two-phase) |
| `extensions/feishu/src/accounts.ts` | dropped 4 casts (only `mergeFeishuAccountConfig` region conflicts) | confirmed | take-theirs (`accountTools` + `nestedObjectKeys: ["tools"]`) |
| `extensions/feishu/src/policy.ts` | dropped 2 casts | confirmed | take-theirs (new `hasExplicitFeishuGroupConfig`) |
| `extensions/feishu/src/setup-surface.ts` | dropped 4 casts (2 conflict regions) | confirmed | take-theirs (drops base helpers; simplified `isFeishuConfigured(cfg)`) |
| `extensions/telegram/src/accounts.ts` | dropped cast (function relocated upstream) | confirmed — #30673 logic is base-origin, preserved in `account-config.ts` | take-theirs |
| `extensions/telegram/src/bot-handlers.runtime.ts` | dropped `requireTopic` cast | confirmed — upstream still needs a cast | take-theirs |
| `extensions/telegram/src/bot-message-context.ts` | dropped 2 casts | confirmed — upstream `directConfig`/`plugin-owned-runtime` richer | take-theirs (import block too) |
| `extensions/telegram/src/bot-message-dispatch.ts` | dropped `directConfig` cast | confirmed | take-theirs (`in`-narrowing) |
| `extensions/telegram/src/bot-native-commands.ts` | dropped `requireTopic` cast | confirmed — `resolveTelegramEffectiveDmPolicy` is upstream | take-theirs |
| `extensions/minimax/src/minimax-web-search-provider.ts` | dropped `as SearchConfigRecord \| undefined` cast | confirmed | take-theirs (lazy-runtime `createTool`) |
| `extensions/moonshot/src/kimi-web-search-provider.ts` | same cast removal | confirmed | take-theirs (lazy runtime) |
| `extensions/google/src/gemini-web-search-provider.ts` | same cast removal | confirmed — cast removal preserved automatically | take-theirs (`withGoogleModelProviderFallbacks`) |
| `extensions/anthropic/cli-migration.ts` | dropped `as NonNullable<AgentDefaultsModels>` cast | confirmed — base==ours except cast | take-theirs (2-arg `seedClaudeCliAllowlist`, `"anthropic/claude-opus-4-8"`) |
| `extensions/browser/src/browser/config.ts` | removed `ssrfPolicy` cast | confirmed | take-theirs (`BrowserSsrFPolicyCompat`) |
| `extensions/irc/src/monitor.ts` | dropped `as CoreConfig` cast | confirmed | take-theirs (`.current()`) |
| `extensions/irc/src/send.ts` | dropped `as CoreConfig` cast | confirmed | take-theirs (`requireRuntimeConfig`); verify no orphaned `runtime` |
| `extensions/memory-core/src/dreaming-phases.ts` | dropped 2 casts | confirmed | take-theirs (adds `primaryWorkspaceDir`) |
| `extensions/qa-lab/src/bus-state.ts` | narrowed `QaBusEventSeed` to 1 member | confirmed — **ours is WRONG (drops 5 kinds)** | take-theirs (full 6-member union) |
| `extensions/tlon/src/monitor/index.ts` | dropped `route` cast | confirmed — model-signature feature is base/upstream-owned | take-theirs (`return { visibleReplySent: false }`); verify no `extRoute`/`extPayload` |
| `extensions/voice-call/src/response-generator.ts` | dropped `SessionEntry` cast | confirmed | take-theirs (`getSessionEntry`); reconcile `sessionEntry`/`resolvedSessionKey` |

**⚠️ FLAGGED EXCEPTIONS:**
- **`extensions/speech-core/src/tts.ts` — modify/delete, `delete-ours`.** Upstream deleted the file; ours only removed a cast. Run `git rm extensions/speech-core/src/tts.ts`. Before finalizing, verify no remaining tlon/voice-call/speech code imports `extensions/speech-core/src/tts`.
- **`extensions/qa-lab/src/bus-state.ts`** — ours narrowed the type *incorrectly* (dropped 5 valid seed kinds); taking theirs is mandatory or `pushEvent` breaks type-checking. Not a cosmetic choice.

---

## 5. Build / Config

### `package.json` (manual-merge)
- Take **theirs** entire root `dependencies` block (exact pins, upstream bumps, new deps: `@openclaw/fs-safe`, `@openclaw/proxyline`, `clawpdf`, `cross-spawn`, `kysely`, `openai`, `typebox`, `typescript`, etc.).
- **Do NOT touch `exports`** — the nabu subpaths `./plugin-sdk/media-uploader` and `./plugin-sdk/media-resolver` (lines 484-490) are outside the conflict and already merged.
- **Drop root `nostr-tools` (`^2.23.3`) and `zca-js` (`^2.1.2`)** — they belong to `extensions/nostr` (`2.23.5`) and `extensions/zalouser` (`2.1.2`) per the plugin-owns-deps invariant; no core `src/**` imports them. ONLY graft them back into root if the develop docker/flat-install actually resolves them from root (verify by building the docker image).
- Do NOT re-add `google-auth-library` (already gone; no nabu code imports it).
- The 6 `nabu-*` extensions declare **zero** runtime deps — nothing to add to root.

### `tsdown.config.ts` (take-theirs)
- Take theirs' `deps: { alwaysBundle: shouldAlwaysBundleDependency, neverBundle: shouldNeverBundleDependency }` verbatim.
- Do **not** re-add `...bundledPluginRuntimeDependencies` / `listBundledPluginRuntimeDependencies` (upstream replaced it with the `.openclaw-runtime-deps.json` manifest mechanism) or `simple-xml-to-json` (dead/unreferenced).
- **The 6 nabu-* entrypoints are NOT hardcoded here** — they are auto-discovered by `collectBundledPluginBuildEntries()` (`scripts/lib/bundled-plugin-build-entries.mjs`), which is untouched by the conflict. They survive regardless.

### `docker-compose.yml` (take-theirs)
- Both hunks: take theirs. Keep the 3 double-quoted ports incl. `"${OPENCLAW_MSTEAMS_PORT:-3978}:3978"`, and the CLI service `env_file: - path: .env / required: false` (nabu relies on this `.env`, pairs with the `/.env` gitignore).
- **Preserve the auto-merged nabu lines outside the markers:** the two `container_name:` entries, `- openclaw-network` membership, and the top-level `networks: openclaw-network: external: true` block (lines 3, 83, 86, 130-131).

### `.gitignore` (manual-merge / union)
- Union the conflict region: keep ours' `.mcp.json` AND all of theirs' additions (`extensions/**/.openclaw-runtime-deps.json` + `-stamp.json`, the two `viewer-runtime.js` entries, `/.opengrep-out/`, `/.crabbox-artifacts`, `.comux*`). The runtime-deps ignores are the counterpart to taking theirs' tsdown refactor.
- Leave the auto-merged nabu lines untouched: `/.env` (line 3) and `nabu-integration/instances/` + its comment (line 221).

### `pnpm-lock.yaml` (regenerate)
- **Never hand-merge the 128 conflict blocks.** Resolve all `package.json` files (root + every extension) first, then run **`pnpm install`** at repo root to regenerate deterministically. Stage the result; verify with `pnpm install --frozen-lockfile` (or `pnpm build`). Keep the Bun lockfile/patches in sync if Bun paths are touched.

---

## 6. Post-Merge Verification Checklist

1. **Confirm the 6 `nabu-*` entrypoints** still emit: `nabu-1password`, `nabu-email`, `nabu-files`, `nabu-gateway`, `nabu-google-workspace`, `nabu-model-router`. These are auto-discovered (not hardcoded in `tsdown.config.ts`/`package.json`), so confirm by checking the `dist/` output after build, not by grepping the config.
2. **Re-apply nabu hooks where upstream moved files:**
   - `pi-embedded-runner → embedded-agent-runner`: Cloudflare AI Gateway streamFn wrapper re-inserted in `run/attempt.ts` (~L2698); media-upload registered in `extensions.ts` (via `../agent-hooks/media-upload.js` or plugin registration per §7).
   - `pi-hooks → agent-hooks`: media-upload files relocated; re-expressed as `AgentToolResultMiddleware`.
   - `server.impl.ts → server-session-events.ts`: `enrichMessageWithFileRefs` wrap re-applied.
   - `method-scopes.ts`/`server-methods.ts`/`server-methods-list.ts → core-descriptors.ts`: 3 `dm.pair.*` descriptors added.
3. **`pnpm install`** — regenerate `pnpm-lock.yaml`; verify `pnpm install --frozen-lockfile`.
4. **`pnpm build`** — must pass (lazy-loading/module-boundary + published-surface changes); scan output for **`[INEFFECTIVE_DYNAMIC_IMPORT]`** warnings (dm-pairing lazy import, media-upload, `@openclaw/*` imports).
5. **Confirm the nabu plugins load** — `pnpm tsgo` clean, and the 6 `nabu-*` plugins register without manifest/contract errors.
6. **Run nabu-model-router test** plus scoped gateway/agent tests: `src/gateway/session-message-events.test.ts`, `src/gateway/server-methods/chat*.test.ts`, gateway method-scopes/method-list tests (assert `listGatewayMethods()` contains `dm.pair.*` resolving to `operator.pairing`, `isPairingMethod("dm.pair.list") === true`), `src/agents/system-prompt.test.ts` (both deliver cases green), and the ported `agent-hooks/media-upload/extension.test.ts` (asserts `result.details.nabuFileIds` / `result.details.media.mediaUrls` / the "N files delivered" confirmation).
7. **Verify nabu-only supporting files survived/resolve:** `src/gateway/chat-file-refs.ts`, `src/plugin-sdk/media-uploader.ts`, `src/agents/tools/deliver-tool.ts`, and **`src/media/mime.ts`** (shown `D` deleted by the merge — must be resolved to keep nabu's `mime.ts`/`detectMime`, or media-upload won't compile).

---

## 7. Open Design Questions (human must decide)

1. **Media-upload registration: adopt upstream's middleware contract vs keep nabu's pi-extension.** Nabu's `api.on("tool_result")` seam (`factories.push(mediaUploadExtension)`) no longer exists upstream. **Path A (recommended):** re-express as a bundled plugin with `contracts.agentToolResultMiddleware: ["openclaw"]` + `api.registerAgentToolResultMiddleware(...)` (matches `extensions/tokenjuice/`, satisfies "core stays extension-agnostic"). **Path B:** wire the middleware directly into `buildAgentToolResultMiddlewareFactory()` in core `embedded-agent-runner/extensions.ts` (faster, lower churn, but core-internal). Decide before re-applying the `pi-embedded-runner/extensions.ts` registration, since the two paths produce different code there.
2. **Where the Files-API `openresponses-http` multi-tool logic re-attaches.** Upstream's multi-tool-call loop (one `function_call` per pending call) replaced nabu's single `pendingToolCalls[0]` emission. The human must confirm nabu's `joinPayloadsWithMedia(payloads)` is the correct `assistantText` source inside upstream's loop, AND manually upgrade the **non-conflicted** streaming block (~L1180) that auto-merged as ours' single-call version — otherwise multi-tool turns silently regress.
3. **`src/media/mime.ts` deletion.** The merge flags it `D`; nabu's `detectMime` is a hard dependency of the media-upload middleware. Decide: keep nabu's `mime.ts`, or retarget the import to upstream's media-mime surface (`@openclaw/media-core/mime`).
4. **`senderIsOwner` drop in the OpenAI/openresponses endpoints.** Upstream deliberately removed owner-tool gating. Confirm nabu added no gating *use* of `senderIsOwner` (analysis says it only forwarded it). If a nabu feature gates on owner status, that must be re-expressed before dropping it.
5. **Non-loopback Control UI guard (`server-runtime-config.ts`).** Nabu intentionally disables a Host-header origin-spoofing security control for containerized/reverse-proxied deploys. Confirm this is still desired post-merge, or whether to instead configure `gateway.controlUi.allowedOrigins` properly.
6. **Root `nostr-tools`/`zca-js` deps.** Drop from root (preferred, plugin-owns-deps) unless the develop docker/flat-install build actually resolves them from root — verify before finalizing `package.json`.
7. **`chat.startup` enrichment.** Upstream routes both `chat.history` and `chat.startup` through `handleChatHistoryRequest`, so re-applying nabu's enrichment there extends it to `chat.startup` (new behavior). Confirm this is acceptable/desirable.
