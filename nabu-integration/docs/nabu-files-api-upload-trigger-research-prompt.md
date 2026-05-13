# Files API — Upload Trigger Architecture Research Prompt

> **For:** External AI research agent (Claude Opus with web search, Perplexity Deep Research, Gemini with grounding).
>
> **From:** Cross-team coordination between `va-openclaw` (TypeScript agent wrapper) and `va-core-nest` (NestJS backend). Phase 3 / PR 1 in flight.
>
> **Self-contained:** the research agent will not have access to either repo's source or our coordination memory. Everything you need is in this prompt.
>
> Copy §1 through §8 verbatim into the research agent. §9 ("Operator notes") is for the human routing this prompt and should be removed before pasting.

---

## §1. What I'm researching and why

I'm implementing a tool-media upload pipeline in OpenClaw (a TypeScript wrapper around the Pi SDK by Mario Zechner — `@mariozechner/pi-coding-agent`). I've built the plumbing — plugin scaffold, SDK seam, HTTP client, retry logic, Idempotency-Key handling, in-memory cache, tenant config, all wired and operational against a live backend Files API. But I can't get the **upload to fire reliably at the right moment** because the agent SDK's lifecycle doesn't expose a clean async interception point between "tool produces media" and "LLM sees the tool result."

The integration goal:

```
TOOL EXECUTES (image-gen, TTS, screenshot, PDF render)
  → produces bytes locally at /home/node/.openclaw/media/.../X.png
  → produces structured `details.media.mediaUrls: ["/local/path"]`
  → emits `MEDIA:/local/path` markers in its text output

[somewhere here, OpenClaw should upload to backend Files API]
  → POST /v1/files-api/skill-upload (multipart)
  → backend returns { fileId, signedUrl, signedUrlExpiresAt, ... }
  → backend persists to MinIO (or Hetzner Object Storage in prod)

LLM is fed the tool result
  → LLM produces assistant text referencing the path/url
  → ideally references the signedUrl, not the local path

ASSISTANT REPLY assembled
  → web chat (via OpenResponses HTTP /v1/responses)
  → channel adapters (Telegram, Slack, Discord, iMessage, WhatsApp, MS Teams)
  → both surfaces should serve the signedUrl, not the local path
  → local file deleted after delivery (durable copy lives on backend MinIO)

CHAT HISTORY RELOAD (days later)
  → backend's `POST /v1/files-api/skill-resolve` re-issues fresh signed URLs
  → for that to work, fileIds must persist in the session.jsonl
  → we use Pi SDK's `ToolResultMessage.details.nabuFileIds: number[]`
    (decided via prior round of research; Pi's `details` field persists verbatim
    and is excluded from `convertToLlm()` so the LLM never sees it)
```

The integration is fully implemented up to the point of "upload happens." Backend is live. Plugin loads. SDK seam works. Cache, retry, idempotency are all coded. **The blocker is purely the upload-trigger architecture inside the SDK lifecycle.**

I need the research agent to recommend an architectural pattern that handles this cleanly across all surfaces, with consideration of:
- Pi SDK's specific lifecycle (hook signatures, sync vs async, event emission points)
- Race conditions between async upload completion and LLM "next-turn" consumption
- Multiple downstream consumers (OpenResponses HTTP, channel adapters, chat-history serve)
- Tool-agnostic design (works for any tool that produces media, not just image-gen)

## §2. What I've already tried and why it's not enough

### Attempt 1: Wrap the channel reply pipeline normalizer

OpenClaw has `createReplyMediaPathNormalizer` (at `src/auto-reply/reply/reply-media-paths.ts:69`) — a function that processes `ReplyPayload.mediaUrls[]` before channel fan-out. I wrapped it with an upload-and-rewrite middleware (`wrapNormalizerWithUploader`) at the two creation sites:
- `src/auto-reply/reply/agent-runner.ts:179`
- `src/auto-reply/reply/agent-runner-execution.ts:538`

**This works for channels** (untested live, but the wiring is correct — when Telegram is wired to a tenant, the normalizer fires for each outbound payload and our wrapper sees `mediaUrls[]` populated correctly).

**This DOES NOT work for OpenResponses HTTP** because that surface uses `agentCommandFromIngress(...)` with `deliver: false`, which calls `agentCommandInternal` → `runAgentAttempt` → `deliverAgentCommandResult`. The reply pipeline normalizer is never called on that path.

### Attempt 2: Add an upload sweep at the OpenResponses HTTP layer

I added `uploadPayloadMediaAndRewrite(payloads)` in `src/gateway/openresponses-http.ts` that runs immediately after `runResponsesAgentCommand` returns. It walks `result.payloads`, finds local-path entries in `payload.mediaUrls`, uploads them, and rewrites the text.

**Observation in live test:** `payload.mediaUrls` arrives `undefined` for the image-gen tool. The tool DOES emit `details.media.mediaUrls = [local paths]` (verified in `src/agents/tools/image-generate-tool.ts:683`) and `MEDIA:` markers in its text. The OpenClaw flow has `pendingToolMediaUrls` state (`src/agents/pi-embedded-subscribe.handlers.tools.ts:280`) that `consumePendingToolMediaIntoReply` (`src/agents/pi-embedded-subscribe.handlers.messages.ts:115`) merges into the `BlockReplyPayload`'s `mediaUrls`. But by the time it reaches `normalizeOutboundPayloadsForJson` in `delivery.ts:269`, mediaUrls is `undefined`.

There's a structural data-loss bug somewhere in `agentCommandInternal` → `runAgentAttempt` → `deliverAgentCommandResult` for the `deliver: false` path. I haven't yet pinpointed it.

### Attempt 3: Regex-extract local paths from the LLM's prose text

Since `payload.mediaUrls` is empty in the OpenResponses path, I added a regex (`LOCAL_MEDIA_PATH_RE`) that matches `/home/node/.openclaw/<...>.{png|jpg|mp4|pdf|...}` patterns in the assistant text. When found, treat each path as a media entry, upload, rewrite.

**This is whack-a-mole with LLM creativity.** Across four identical test prompts ("generate an image of a sunset"), the LLM emitted the path in four different forms:

1. `![Sunset](MEDIA:/home/node/.openclaw/media/tool-image-generation/image-1---abc.png)` — literal `MEDIA:` prefix inside markdown URL
2. `![Sunset](https://agent-cdn.minimax.io/matrix_agent/.../generated_image.png)` — the upstream model's CDN URL (no local path visible at all)
3. `Saved to: \`/home/node/.openclaw/media/.../image-1---xyz.png\`` — bare path in prose with backticks, no markdown
4. `![Sunset](https://docs.openclaw.ai/api/media/file?path=home%2Fnode%2F.openclaw%2Fmedia%2F...)` — fully hallucinated URL with the path URL-encoded as a query parameter

The regex catches forms 1 and 3. Forms 2 and 4 require either (a) decoding URL-encoded paths, (b) recognizing that an unfamiliar hostname is fake, or (c) some other heuristic. The complexity escalates with each "form" the LLM invents, and there's no upper bound — given a sufficiently creative model, we'll keep adding regex branches indefinitely.

**This is a hack.** Parsing LLM prose to recover structured data we already had upstream is bad architecture.

## §3. What's locked (do NOT reconsider — out of scope)

- Backend wire contracts: `POST /v1/files-api/skill-upload`, `POST /v1/files-api/skill-resolve`, `ChatHistoryMessage.fileRefs?: Array<...>` extension, single skill-token purpose `files-api`. Backend has already shipped all of this.
- Persistence strategy: fileIds live in `ToolResultMessage.details.nabuFileIds: number[]` (Pi SDK's native typed field — verified via prior research that this persists verbatim to JSONL and is excluded from `convertToLlm()`).
- The SDK we wrap: `@mariozechner/pi-coding-agent` (Pi SDK by Mario Zechner). We don't fork it. We use the public API surface only.
- The SDK exposes a sync `tool_result_persist` hook (via `transformToolResultForPersistence` in our `src/agents/session-tool-result-guard.ts:76-279` wrapper). This hook fires BEFORE `SessionManager.appendMessage()` writes the JSONL line, but it cannot await async work because its return type is sync.
- Pattern A (channel delivery) is locked: OpenClaw fetches bytes from signedUrl, uploads multipart to channel API. The channel-side fan-out is solved IF the signedUrl reaches `mediaUrls[]` in the outbound payload.

## §4. Pi SDK lifecycle: what we know and what we don't

The Pi SDK (`@mariozechner/pi-coding-agent` v0.73.1) is the upstream agent runtime. We wrap it. The relevant lifecycle is:

```
1. LLM emits tool_call
2. Pi runtime invokes our registered tool implementation
   (registered via OpenClaw's plugin SDK; e.g. image_generate_tool in src/agents/tools/image-generate-tool.ts)
3. Our tool returns: { content: [{type:"text",text:"..."}], details: {media:{mediaUrls:[]}}, isError, ... }
4. Pi constructs ToolResultMessage
5. Pi calls sessionManager.appendMessage(toolResult)
   ↑ Our session-tool-result-guard wraps appendMessage and fires:
     - tool_result_persist hook (sync, can return modified message)
     - before_message_write hook (sync)
   ↑ Then originalAppend writes the JSONL line
6. Pi feeds the tool result back to the LLM for the next turn
7. LLM responds (this is where our race window is — between upload start and this point)
8. SessionManager.appendMessage(assistantMessage) — assistant message persisted
```

Steps 3–5 happen inside Pi's tool-handling loop. Step 6 happens in Pi's LLM-call loop. Both are inside the SDK; we don't get to inject async work between them through any documented hook.

**Confirmed via prior research (Round 9):**
- Pi SDK's `SessionManager.appendMessage` is `JSON.stringify + appendFileSync` — synchronous I/O, no buffering for our purposes
- `ToolResultMessage.details: any` is persisted verbatim and excluded from `convertToLlm()`
- The `transformToolResultForPersistence` hook signature is sync: `(message: AgentMessage, meta) => AgentMessage | undefined`
- `getGlobalHookRunner().runToolResultPersist()` (in `src/plugins/hooks.ts:835-862`) explicitly warns if a handler returns a Promise — they're not awaited

**Open question:** does Pi SDK expose any **async** event/hook anywhere in the tool-execution lifecycle that we could await? Possibilities:
- Per-tool wrapping at registration time — our tool's `run()` itself is async; we control the return shape
- An async "post-tool, pre-LLM-feed" hook we haven't discovered
- The `pi-agent-core` event stream might have async listener support

These are open questions for the research agent.

## §5. The architectural options to evaluate

Pick a primary recommendation among these. Or propose a hybrid. Or surface a better one I haven't considered.

### Option A — sessionCache with fire-and-forget upload from sync hook + assembler awaits

Inside `tool_result_persist` (sync hook):
1. Extract local paths from `details.media.mediaUrls` + `splitMediaFromOutput(message.content)`
2. For each local path, kick off async `uploader({ filePath })`
3. Store the **Promise** (not the result) in a session-scoped cache: `sessionCache.set(localPath, uploadPromise)`
4. Set `details.nabuFileIds` to placeholder OR populate via microtask after Promise settles (race with appendFileSync — Promise probably doesn't settle in time)
5. Return — hook completes, Pi continues, LLM gets fed the unmodified tool result

In downstream assemblers (openresponses-http, channel reply pipeline):
1. Scan text for substrings matching `sessionCache` keys (exact local paths, not regex)
2. `await` each Promise — this joins the in-flight upload if it's still running
3. Replace text with signedUrl, also push to structured `fileRefs[]`

**Pros:** uses only the SDK's existing sync hook; single shared cache for all consumers; works tool-agnostically.

**Cons:** Race for `details.nabuFileIds`. The hook returns before upload settles, so when `appendFileSync` writes the JSONL line, fileIds aren't known yet. Mitigations:
- Don't populate `details.nabuFileIds` from the hook; instead, have the chat-history-reload code path do its own lookup by walking the cache by sessionId. But cache is in-memory; lost on restart.
- Or: write a placeholder, then RE-WRITE the JSONL line after upload settles (but Pi's SessionManager is append-only — `_rewriteFile()` only runs on schema migration).
- Or: emit a `nabu-file-attachment` `CustomEntry` AFTER upload settles via `sessionManager.appendCustomEntry()`. Sibling line in the same JSONL. Chat-history-reload reads both regular messages AND custom entries.

### Option B — Wrap tool implementations at registration time

Provide a helper `wrapToolWithMediaUpload(toolDef)` that other plugins call. Inside the wrapper:
1. Call the original `toolDef.run(...)` and `await` it
2. Extract local media paths from the result
3. `await uploader({...})` for each
4. Mutate the result: rewrite `details.media.mediaUrls` to signedUrls; rewrite `content[].text` to replace local paths with signedUrls
5. Return the mutated result to Pi

Pi then sees a result where the LLM is fed the signedUrl, not the local path. No race, no downstream rewriting.

**Pros:** clean — uploads synchronously inside our async tool-execution code; downstream is naive.

**Cons:** requires wrapping every tool that emits media. Bundled tools like `image_generate_tool.ts`, `tts_tool.ts`, `screenshot_tool.ts`, `pdf_render_tool.ts` would all need this. New tools opt-in via the wrapper. Easy to miss a tool.

Could mitigate by hooking core's `api.registerTool` so EVERY registered tool auto-gets the wrapper. But that's a core change touching `src/plugins/registry.ts`.

### Option C — Use `appendCustomEntry` instead of `details.nabuFileIds`

After upload completes (some milliseconds later), append a sibling `CustomEntry` line to the JSONL via `sessionManager.appendCustomEntry('nabu-file-attachment', { toolCallId, fileIds, localPaths })`. The entry sits alongside the message it relates to. Chat-history-reload reads both regular messages AND custom entries.

Combine with Option A: hook starts uploads, microtask completion appends custom entries, downstream assemblers await cache to do text rewriting.

**Pros:** sidesteps the `details.nabuFileIds` race entirely. The Round 9 research recommended this as the Tier 2 fallback. Pi SDK explicitly supports custom entries that round-trip in the JSONL.

**Cons:** correlation in history reload requires walking both message types. Slightly more complex read path. We previously committed to Option C-as-`details` but this is functionally Tier 2.

### Option D — Modify OpenClaw core to propagate mediaUrls reliably

Fix the data-loss bug in `agentCommandInternal` → `runAgentAttempt` → `deliverAgentCommandResult` (the `deliver: false` path strips `pendingToolMediaUrls` merge somewhere). Then the upload sweep in `openresponses-http.ts` gets authoritative `payload.mediaUrls` and the existing pipeline works.

**Pros:** smallest diff if the bug is localized.

**Cons:** unknown blast radius — that pipeline is shared across many features. May need careful refactoring.

### Option E — Hybrid: structured wire format, ignore the LLM's prose

Add `media: [{ type: "image", url, fileId }]` to the OpenResponses `OutputItem` schema and to `ChatHistoryMessage`. FE renders from this structured field, not from markdown parsing. The LLM's text can be anything — the FE doesn't depend on it.

Server-side: continue with Option A or C for the actual upload. The structured field is populated from sessionCache. Text rewriting becomes nice-to-have, not load-bearing.

**Pros:** decouples server-side reliability from LLM rendering. FE is more robust.

**Cons:** requires FE adoption. May not happen quickly. Backend's `ChatHistoryMessage.fileRefs?` extension is already this structured field, so the precedent is there.

### Option F — Pi SDK upstream contribution

Propose to Mario Zechner an async hook between tool execution and LLM-feed. Specifically: `onToolResult: async (toolResult) => toolResult | undefined`. This is the "right" architectural answer but depends on someone else's roadmap.

**Pros:** correct architecture.

**Cons:** unknown timeline; we ship before this lands; need a fallback anyway.

## §6. Research questions

Critical:

1. **Does Pi SDK v0.73.1 expose any async tool-result interception point** I haven't found? Search the Pi SDK source (`badlogic/pi-mono` monorepo) for:
   - Async hooks in the tool execution lifecycle
   - Event emitters that fire AFTER tool execution but BEFORE LLM feed
   - Any documented extension surface for "modify tool result before LLM sees it"
   - Use the npm tarball: `npm pack @mariozechner/pi-coding-agent@0.73.1` → search `dist/` for `await.*hook`, `Promise.*hook`, `emit.*toolResult`, etc.

2. **What does the production-grade tool wrapping pattern look like in similar systems?** Surveys to compare:
   - LangChain tool decorators (`@tool` in Python, BaseTool in JS)
   - LangGraph node interceptors
   - OpenAI Assistants API native files attachment (the model never sees the local path because the API ingests files at registration time — analogous to Option B)
   - Microsoft AutoGen tool wrappers
   - Anthropic's MCP `resource_link` content blocks
   - Block's Goose tool spec
   - How does Cline / Aider / Continue handle "tool produces file → reference in chat"?

3. **For the race condition in Option A** — is there a known pattern for "async work triggered from sync hook, downstream awaits the future"? Look at:
   - Node `Effect.ts` / `fp-ts` for explicit Promise-tracking
   - React Suspense for resource fetching (the conceptual analogue)
   - LangGraph checkpointers with intermediate state
   - Any benchmark on "how long does Pi SDK's LLM next-turn typically take" — if it's 1–3+ seconds and the upload is ~200–500ms, the race window is in our favor and a simple `await cache.get(path)` in the assembler works.

4. **The data-loss bug in Option D** — for a TypeScript wrapper around an agent SDK where ToolResult.details.media.mediaUrls populates correctly upstream but arrives undefined at the response assembler, what's the typical root cause? (Truthy-coalesce bug? Missing field in a TypeScript narrowing? Schema validator stripping unknown fields?)

Important:

5. **OpenAI Assistants API analog.** Their model never sees a local file path — files are pre-registered, the model references `file_id`. What would the equivalent be for our case where the user prompt is "generate an image"? The image is generated AT TOOL TIME, not pre-registered. Is there a known pattern for "register an output file before continuing the conversation"?

6. **MiniMax tool inventory.** The first attempt showed the LLM emitting a `https://agent-cdn.minimax.io/...` URL — meaning the upstream MiniMax response includes a CDN URL that our tool also surfaces somehow. This may be exposed via the tool's `details` field. If so, the LLM is choosing the CDN URL over the local path. Need to figure out whether our `image_generate_tool.ts` should suppress the MiniMax CDN URL or upload-and-rewrite it. Look at how `image_generate_tool.ts` constructs its result (`src/agents/tools/image-generate-tool.ts:665-690`).

Useful:

7. **MEDIA: marker convention.** OpenClaw's existing convention is for tools to emit `MEDIA:<path>` in their stdout, then `splitMediaFromOutput` strips it and populates `mediaUrls`. The LLM sometimes echoes `MEDIA:` literally into its response markdown URLs (`![alt](MEDIA:/path)`), which is malformed. Is there a known prompt-engineering pattern to prevent the LLM from echoing internal markers like this?

## §7. Decision matrix to fill

| Option | Race window | Diff size | Cleanliness | Per-tool surgery | SDK fork required | Recommended? |
|---|---|---|---|---|---|---|
| A — sessionCache + fire-and-forget | yes (mitigatable) | medium | medium | no | no | ? |
| B — wrap tool implementations | none | large per-tool | high | yes | no | ? |
| C — appendCustomEntry sibling | mostly removed | medium | medium | no | no | ? |
| D — fix mediaUrls propagation | yes (until fixed) | unknown | high if scoped | no | no | ? |
| E — structured FE wire format | no | medium + FE | high | no | no | ? |
| F — upstream Pi SDK hook | future | small once landed | very high | no | no (just PR) | ? |

For each: which surfaces are well-served (OpenResponses HTTP / channel adapter / chat-history reload) and which still need a fallback?

## §8. Success criteria for the report

A markdown report with:

1. **Pi SDK lifecycle survey:** any async hooks found, with file:line citations from the Pi SDK source (npm tarball or GitHub badlogic/pi-mono). If nothing async exists for tool results, say so explicitly.
2. **Per-option deep evaluation** — race characteristics, failure modes, observable bugs you'd predict, what the operational story looks like for restart / crash / retry.
3. **Prior art survey** — at least 3 comparable agentic systems and how they handle tool-output media. Include links.
4. **Concrete recommendation** — which option (or combination) to implement first, why, and what fallback you'd build for the 5% case it doesn't cover.
5. **Race-window quantification** — given typical Pi SDK LLM call latencies (look up Anthropic API latencies for Sonnet/Opus, MiniMax latencies), is the Option A race window viable in practice?
6. **Pi SDK pull request shape** — if upstream contribution (Option F) is viable, what should the PR look like? Hook signature, naming, backwards compat.

## §9. Operator notes (REMOVE BEFORE PASTING)

Routing recommendations:

- **Claude Opus 4.x with web search + extended thinking** is best for the Pi SDK source archaeology and architectural reasoning. Run this prompt there primarily.
- **Perplexity Pro Deep Research** for the prior-art survey (§6 Q2) if Opus comes up thin on AutoGen/LangGraph specifics.
- Run §6 Q1 (Pi SDK async hook search) twice with two agents — high-cost-of-wrong-answer, worth reconciling.

Prior context the research agent doesn't need but you should know:

- This builds on prior research that established Option C (`ToolResultMessage.details.nabuFileIds`) as the persistence strategy. The earlier Round 9 prompt is in this repo at `nabu-integration/docs/nabu-files-api-round-9-research-prompt.md` and the result at `nabu-integration/docs/files-api-round-9-result.md`. The current research is the upload-trigger layer, sitting underneath the persistence layer.
- Backend has shipped `/skill-upload`, `/skill-resolve`, `ChatHistoryMessage.fileRefs?` interface. All wire contracts are locked. Only OpenClaw-internal architecture is in scope here.
- The plugin code is at `extensions/nabu-files/`. The SDK seam is at `src/plugin-sdk/media-uploader.ts`. The current (hacky) OpenResponses path is at `src/gateway/openresponses-http.ts`.

After report returns:

- Post a Round 11 memory entry to remote MCP memory: "upload-trigger architecture chosen: <option>. Implementation plan: <link or summary>."
- Discard the regex hack and the duplicate upload sites. Implement the chosen architecture in a fresh PR 1.x.

Files in the repo this prompt references:

- `extensions/nabu-files/` — plugin
- `src/plugin-sdk/media-uploader.ts` — SDK seam
- `src/auto-reply/reply/reply-media-uploader.ts` — channel-pipeline wrapper
- `src/auto-reply/reply/reply-media-paths.ts:69` — `createReplyMediaPathNormalizer`
- `src/auto-reply/reply/agent-runner.ts:179` — channel-pipeline wrap site
- `src/auto-reply/reply/agent-runner-execution.ts:538` — channel-pipeline wrap site
- `src/gateway/openresponses-http.ts` — OpenResponses HTTP path with the broken upload sweep + regex hack
- `src/agents/agent-command.ts` — agentCommandInternal (the path used by OpenResponses)
- `src/agents/command/delivery.ts` — deliverAgentCommandResult (where mediaUrls gets lost)
- `src/agents/command/attempt-execution.ts` — runAgentAttempt
- `src/agents/session-tool-result-guard.ts:76-279` — the `transformToolResultForPersistence` hook installation point
- `src/agents/session-tool-result-guard-wrapper.ts` — wires the hook to the plugin hook runner
- `src/plugins/hooks.ts:835-862` — `runToolResultPersist` (sync runner, can't await)
- `src/agents/pi-embedded-subscribe.handlers.tools.ts:280` — `pendingToolMediaUrls` state
- `src/agents/pi-embedded-subscribe.handlers.messages.ts:115` — `consumePendingToolMediaIntoReply`
- `src/agents/tools/image-generate-tool.ts:665-690` — concrete tool that produces `details.media.mediaUrls = [local paths]`
- `src/media/parse.ts:123-293` — `splitMediaFromOutput` (the existing MEDIA: marker extractor)
- `src/infra/agent-events.ts:251` — `onAgentEvent` listener (worth checking if tool results emit on this stream)
- `src/infra/outbound/payloads.ts:124` — `normalizeOutboundPayloadsForJson` (where the final wire payload gets assembled)
