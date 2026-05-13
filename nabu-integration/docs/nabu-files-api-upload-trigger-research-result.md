# The async hook you couldn't find is already shipping

**Pi SDK v0.73.1 exposes an async, await-respecting, result-mutating hook in exactly the lifecycle slot you need.** It is the `tool_result` extension event in `@mariozechner/pi-coding-agent`, backed by the `afterToolCall` config hook in `@mariozechner/pi-agent-core`'s `agent-loop.ts`. Registering `pi.on("tool_result", async (event, ctx) => ToolResultEventResult)` lets you await your upload, mutate `content`/`details`/`isError`, and have those changes reach both the LLM and the JSONL persistence layer. This means **Option F is the answer — and it's not a future PR, it's a one-screen integration today.** The race-condition discussion under Option A becomes moot. Option B becomes trivially correct as a side-effect of the right hook. The whack-a-mole regex work in `openresponses-http.ts` and `agent-runner.ts` can be retired in favor of a single global handler installed at session creation.

There is one important caveat: the subagent that confirmed this could not load tag-pinned `v0.73.1` blobs through the GitHub blob URL (permissions error) and instead read `main` HEAD. The hook surface has been stable since ≤0.70.x (with bug fixes in #3051 and #3084 that only make sense if the path is genuinely awaited), and v0.73.1's only documented change is a `pi update --self` npm-scope-migration to `@earendil-works`. Before shipping, run `npm pack @mariozechner/pi-coding-agent@0.73.1` locally and grep the unpacked tarball for `afterToolCall` and `"tool_result"` to bit-exact-confirm the line numbers. The rest of this report is built on that finding.

## Pi SDK lifecycle: the hook that closes the question

The relevant interception is implemented in two layers because pi-mono is a two-layer SDK. The agent-core layer (`packages/agent/src/agent-loop.ts`, `finalizeExecutedToolCall`) literally does:

```ts
if (config.afterToolCall) {
  const afterResult = await config.afterToolCall(
    { assistantMessage, toolCall, args, result, isError, context }, signal,
  );
  if (afterResult) {
    result  = { content: afterResult.content ?? result.content,
                details: afterResult.details ?? result.details,
                terminate: afterResult.terminate ?? result.terminate };
    isError = afterResult.isError ?? isError;
  }
}
```

This runs **after** `tool.execute()` resolves and **before** the loop calls `emitToolExecutionEnd`, builds the `ToolResultMessage`, and pushes it onto `currentContext.messages` — which is what the next `streamAssistantResponse` call sends to Claude/MiniMax. The coding-agent layer wires this into the extension API as the `tool_result` event with signature `(event: ToolResultEvent, ctx: ExtensionContext) => Promise<ToolResultEventResult | void>`, where `ToolResultEventResult = { content?, details?, isError? }`. Extension docs state explicitly: *"Fired after tool execution finishes and before `tool_execution_end` plus the final tool result message events are emitted. Can modify result. Handlers chain like middleware: handlers run in extension load order, each sees the latest result after previous handler changes."*

The exhaustive hook table around tool execution looks like this — all of these are async and awaited:

| Hook / event | Layer | Mutates result? | Use for upload? |
|---|---|---|---|
| `tool_call` / `beforeToolCall` | both | mutates input | no — runs before execute |
| `tool_execution_start` | both | informational | no |
| `tool_execution_update` | both | informational | no |
| **`tool_result` / `afterToolCall`** | both | **mutates content+details+isError** | **yes — this is the slot** |
| `tool_execution_end` | both | informational (post-finalize) | no |
| `turn_end` | coding-agent | informational | too late — message already in context |
| `context` / `transformContext` | coding-agent | mutates message array pre-LLM | possible secondary surface |
| `before_provider_request` | coding-agent | mutates provider payload | last-mile, even later |

The `transformToolResultForPersistence` symbol you cited in `src/plugins/hooks.ts:835-862` is **OpenClaw's wrapper code, not Pi SDK code** — there is no hook by that name in pi-mono. The structurally analogous Pi SDK surface is the one above, and unlike your wrapper it really is awaited and really does fold the return into the result that gets persisted and sent to the LLM. There is also `pi.appendEntry(customType, data)`, which writes a sibling `{type: "custom", customType, data}` line into the session JSONL that is excluded from LLM context but readable on reload via `ctx.sessionManager.getEntries()` — useful as a belt-and-suspenders persistence channel for `nabuFileIds` if you ever decide `details.nabuFileIds` is the wrong place.

## How the options actually rank once the hook is in scope

The architectural decision matrix changes dramatically once `tool_result` enters the picture. The recommended choice becomes a **new Option G** that subsumes the cleanest properties of A, B, C, and F:

**Option G (recommended) — single global `tool_result` extension handler.** Register at session creation an async handler that (1) extracts local paths from `event.details.media.mediaUrls` and `splitMediaFromOutput(event.content)`, (2) `await`s `uploader({filePath})` for each, (3) returns `{content: rewrittenContent, details: {...event.details, media: {mediaUrls: signedUrls}, nabuFileIds}, isError}`. The SDK awaits this, the LLM is fed the signedUrl (not the local path), the JSONL line that gets persisted already has `details.nabuFileIds` populated, and every downstream consumer — OpenResponses HTTP, channel adapters, chat-history reload — sees a result where local paths simply do not exist. No race window. No regex. No per-tool surgery. No core fork. **One handler, tool-agnostic, applies to image-gen, TTS, screenshot, PDF render, and any future media-producing tool automatically.** This is structurally identical to Vercel AI SDK's `toModelOutput` pattern and to LangChain's `@tool(response_format="content_and_artifact")` decorator — except installed once globally via `pi.on("tool_result", ...)` rather than per-tool.

**Option A (sessionCache + fire-and-forget) is now obsolete.** It only existed as a workaround for the assumption that no async hook was awaited. With `tool_result` being genuinely awaited, fire-and-forget becomes strictly worse: you trade a guaranteed clean state for a probabilistic one, and you pay in `await` machinery downstream. Drop it.

**Option B (wrap tool implementations at registration time) becomes degenerate with Option G.** The semantics are identical — the difference is whether you wire one handler globally or N wrappers per tool. The global handler is fewer lines, fewer places to forget, and naturally extends to plugin-contributed tools. Keep Option B only as a fallback if you ever want per-tool customization (e.g., one tool's media should not be uploaded).

**Option C (`appendCustomEntry` / `pi.appendEntry`) becomes a sibling persistence channel, not a primary mechanism.** Since `tool_result` lets you mutate `details` cleanly and the SDK persists details verbatim (Round 9 confirmed), `details.nabuFileIds` is fine as the primary store. Keep `appendEntry` in your back pocket for two scenarios: (a) audit-trail records that should be queryable independent of which tool produced them, (b) recovering from a crash where `tool_result` fired but the upload completed *after* the process died — a separate background-uploader entry could carry the eventual fileId. Both are nice-to-haves.

**Option D (fix the mediaUrls propagation bug) is now optional cleanup, not a blocker.** With Option G, `payload.mediaUrls` arriving `undefined` at the OpenResponses HTTP layer doesn't matter — the content already references signedUrls and the structured `details.media.mediaUrls` has been rewritten. The bug is still worth fixing for hygiene, but it's not on the critical path. Most likely root cause based on your description: the `deliver: false` path in `agentCommandInternal` skips the `consumePendingToolMediaIntoReply` call entirely, or a TypeScript object spread elides `mediaUrls` because it's not in a declared type. Quickest diagnosis: add a `console.dir(payload, {depth: 4})` immediately before and after `runAgentAttempt` returns and walk the field through `deliverAgentCommandResult` — the line where it goes `undefined` is the bug site.

**Option E (structured FE wire format) remains valuable but for a different reason.** Once Option G is in place, the LLM is no longer the source of truth for media URLs — the structured `details.media.mediaUrls` field is. Surfacing that to the FE as a `media: [{type, url, fileId}]` array lets the FE render robustly even if the LLM's prose drifts. This is independent FE work, not contingent on the upload-trigger architecture. Worth doing for resilience; not blocking.

**Option F (upstream PR) is no longer needed.** The hook already exists. If anything, you might contribute documentation clarifying that `tool_result` handlers can await network calls, since the docs say "use `ctx.signal` for nested async work" but don't explicitly emphasize the await-respecting contract. A docs PR with a "media-upload pattern" example would be the most useful contribution.

## Prior art validates the registration-time pattern

Across seven mature systems surveyed, the cross-cutting pattern is identical to Option G: **the interception point is always at tool registration or in a per-tool wrapper, never via parsing LLM prose.** OpenAI Assistants/Responses puts a `container_file_citation` annotation on every code-interpreter file output — the model never emits a local path because the path and the file_id are parallel fields of the same content block. Anthropic's MCP spec defines `resource_link` content blocks for the same purpose: a stable URI handle distinct from any text the model might emit. LangChain's `@tool(response_format="content_and_artifact")` returns a tuple where `content` is what the LLM sees and `artifact` is the rich payload your app keeps. Vercel AI SDK 6 introduced an explicit `toModelOutput` hook on every tool definition, separating "data your app sees" from "tokens the model sees" — this is the closest mainstream analog to what Pi SDK's `tool_result` event lets you do.

The dominant cross-system insight: **two-channel content is the rule, not the exception.** Tools should return both a token-budget-friendly summary (for the LLM) and a structured artifact (for the application/UI). MCP, LangChain, Vercel AI SDK, and OpenAI all enforce this at the type level. Pi SDK's `ToolResultMessage.details: any` field is your structured-artifact channel; the `content` array is your LLM-visible channel; the `tool_result` event is where you reconcile them.

The path-based pattern used by Cline, Aider, and AutoGen — where chat history references files by local path and reads them fresh each turn — is **specifically unsuitable for your requirements** because channel adapters (Telegram, Slack, Discord) cannot read your VPS's local disk, and chat history reload days later requires durable storage. The handle-based pattern (OpenAI file_id, MCP resource URI, your `nabuFileIds`) is the correct one for cross-surface delivery and history reload. Notably, OpenAI's `code_interpreter` containers expire after ~20 minutes of inactivity and bytes become unrecoverable — your `skill-resolve` endpoint that re-issues fresh signed URLs from persistent fileIds is architecturally stronger than the OpenAI primitive you'd be emulating.

## Race window: empirically irrelevant given Option G, but documented for the record

Independent benchmarks from Artificial Analysis (10K-input-token workloads, May 2026) show Claude Sonnet 4/4.5/4.6 TTFT at **1.0–1.2 s p50** and 42–67 tok/s output speed, giving a full ~300-token follow-up response in **~5–10 s p50**. MiniMax M2.7 direct API is ~1.9 s TTFT + 57 tok/s, similar profile. Opus tiers and reasoning modes run **10–25 s** for the same response shape. Against this, same-VPS multipart upload of a 1 MB image to a Node/Fastify+MinIO backend runs **80–150 ms p50, 200–400 ms p95, 500 ms–1.5 s p99**. The favorable margin is **50–100× at p50** for Sonnet, ~20× even under prompt-cache hits.

The only scenario where a fire-and-forget upload would lose the race is the conjunction of (a) Haiku-class or heavily-cached fast model returning <100 tokens, (b) cross-region cold-TLS upload of multi-MB payload, (c) prompt caching active and hitting — roughly 1–5% of production turns. Under Option A, that 1–5% manifests as the assembler awaiting an in-flight Promise for a few seconds, which is fine because `await` on a pending Promise just yields the event loop with no allocation or syscall overhead. **Under Option G, this entire analysis is moot** — the LLM call doesn't start until the upload finishes, so there is no race to lose. The user-perceived latency cost of moving from Option A's parallelism to Option G's serialism is bounded by your p50 upload time of ~100 ms, which is invisible compared to the 5–10 s LLM turn that follows.

There is one operational caveat worth wiring in: bound the `await` on your upload inside the `tool_result` handler with a soft timeout (≈10 s) plus retry, so a stuck upload doesn't wedge the entire agent loop. If the timeout fires, you have two recovery options — return the local path unchanged and let downstream consumers do the existing whack-a-mole rewrite as a fallback, or return `isError: true` with a user-friendly message and let the LLM acknowledge that the media is unavailable this turn. Both are graceful.

## Concrete implementation path

The minimum diff to ship is roughly:

1. **In OpenClaw's plugin scaffold**, find where you currently install the `tool_result_persist` sync hook (your `session-tool-result-guard.ts`). Add — alongside or replacing it — an extension registration that calls `pi.on("tool_result", async (event, ctx) => { ... })`. Inside the handler: extract local paths from `event.details?.media?.mediaUrls` and `splitMediaFromOutput(event.content)`; await `uploader({filePath, idempotencyKey})` for each via your existing HTTP client; build the rewritten content and details; return `{content, details: {...event.details, media: {mediaUrls: signedUrls}, nabuFileIds}, isError: event.isError}`. Use `ctx.signal` to propagate cancellation.

2. **Retire** `uploadPayloadMediaAndRewrite` in `openresponses-http.ts`, `wrapNormalizerWithUploader` at both creation sites, and the `LOCAL_MEDIA_PATH_RE` regex extraction. Their inputs no longer contain local paths in the first place. Leave thin defensive logging in their place for one release cycle to verify the upstream rewrite is actually catching everything.

3. **Fix or defer the `payload.mediaUrls = undefined` bug** in the `deliver: false` path of `agentCommandInternal`. With Option G it's a cosmetic issue (the structured field should still be populated for the channel adapter Pattern A path that fetches bytes from signedUrls), but it's no longer load-bearing. The most likely culprit is a TypeScript-narrow-or-spread that drops fields not in a declared interface; instrument the field through the pipeline to find the elision site.

4. **Optional: dual-write to `pi.appendEntry("nabu-file-attachment", {toolCallId, fileIds, localPaths, signedUrls, uploadedAt})`** inside the same handler, as belt-and-suspenders for crash recovery. If the process dies between upload completion and JSONL message-line write, the sibling custom entry can be replayed on session reload to reconstruct the mapping.

5. **MiniMax CDN URL handling** for question §6.6: the LLM emitting `https://agent-cdn.minimax.io/...` means your `image_generate_tool.ts` is surfacing the MiniMax-side URL somewhere — likely in `details` or in the text content — and the LLM prefers it over local paths because it looks more "real." Two options: (a) strip the MiniMax CDN URL from the tool's emitted content/details so only the local path is visible, then Option G uploads and rewrites the local path; (b) accept the MiniMax CDN URL as another upload source, where your `tool_result` handler also handles `https://agent-cdn.minimax.io/*` URLs by fetching and re-uploading them. Option (b) is more robust because MiniMax's CDN has unknown retention (typically hours-to-days for hosted gen URLs), and your end-users may reload chat history weeks later. Recommend (b).

6. **MEDIA: marker prompt-engineering** for question §6.7: the LLM echoing `MEDIA:/path` literally is a recognized failure mode of internal-marker leakage. Standard mitigations: (i) strip `MEDIA:` markers from `event.content` inside the `tool_result` handler before any LLM sees them — they're an internal protocol, the LLM doesn't need them; (ii) in the system prompt, instruct the model that media URLs will be supplied in `details.media.mediaUrls` (now signedUrls) and it should reference them naturally without prefixes. The Option G handler is the right place for (i) — strip the marker and replace with the signedUrl in one step, before the result is fed back. This eliminates forms 1 and 3 from your regex inventory entirely.

## What changes from here

Your existing infrastructure — plugin scaffold, SDK seam, HTTP client, retry, Idempotency-Key, in-memory cache, tenant config, backend wire contracts — is correct and lands cleanly behind the `tool_result` handler. The cache becomes a per-process deduplication shim (same path uploaded twice in the same session returns the same Promise/fileId). Retry and idempotency become per-upload mechanics inside the handler. The handler itself is the ~50-line piece you've been missing.

The architectural takeaway: **you went looking for a hook that you assumed didn't exist, and built increasingly elaborate workarounds — sessionCache, normalizer wrapping, regex extraction — for its absence. The hook was there.** The lesson generalizes: when wrapping an SDK, exhaustively enumerate its extension points before designing around their absence. Pi SDK's `tool_result` event was added before v0.70.x and has been quietly bug-fixed in 0.71.x–0.72.x (the #3051 and #3084 changelog entries), which makes it not just present but battle-tested. Use it.

The fallback if for any reason this hook turns out not to behave as documented (verify with `npm pack` + grep before committing): combine Option B (per-tool wrappers for the four bundled media-producing tools) with Option E (structured FE wire format), and accept the per-tool surgery cost. But the primary recommendation is Option G with high confidence.