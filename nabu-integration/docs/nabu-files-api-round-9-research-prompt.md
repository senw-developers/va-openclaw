# Files API — Persistence Strategy Research Prompt

> **For:** External AI research agent (Claude Opus with web search, Perplexity Deep Research, Gemini with grounding, etc.).
>
> **From:** Cross-team coordination between `va-openclaw` (TypeScript agent wrapper) and `va-core-nest` (NestJS backend).
>
> **Self-contained:** the research agent will not have access to either repo's source or our coordination memory. Everything you need is in this prompt.
>
> Copy §1 through §8 verbatim into the research agent. §9 ("Operator notes") is for the human routing this prompt and should be removed before pasting.

---

## §1. What I'm researching and why

I'm designing a file-attachment system that spans two services and need to decide how to persist file-reference metadata so it survives chat-history reload. The decision turns entirely on how a handful of agent SDKs handle the JSONL session logs they write — specifically, whether content I inject into events I control round-trips through the SDK's persistence layer faithfully enough to regex-extract on read.

I don't have first-hand knowledge of the relevant SDK internals. I need you to investigate.

### The system, briefly

- **Backend (Service A)** owns binary storage (object store) and exposes:
  - `POST /v1/files-api/skill-upload` — uploads bytes, returns `{ fileId: int, signedUrl, signedUrlExpiresAt, name, mimeType, sizeBytes }`
  - `POST /v1/files-api/skill-resolve` — takes `{ fileIds: int[] }`, returns fresh signed URLs (10-min TTL). Used at chat-history reload time because signed URLs expire.
- **Agent wrapper (Service B, "OpenClaw")** is a TypeScript wrapper around upstream agent SDKs. It adds multi-channel routing (Telegram/Slack/etc), plugins, reply-pipeline middleware, and exposes a WebSocket RPC interface to Service A.
- When a tool produces a file (image-gen, TTS, screenshot, PDF render), OpenClaw's reply-pipeline middleware uploads it to Service A, gets a `fileId`, and needs to record that fileId in a way that survives until chat-history reload many days later.
- Chat history is persisted by the **upstream agent SDK**, NOT by OpenClaw. OpenClaw reads the SDK's `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` for telemetry only — the SDK owns the JSONL writer.

### What's locked (do NOT reconsider — out of scope)

- Backend wire contracts (`/skill-resolve` response shape, `fileRefs[]` structure on chat-history responses, single skill-token purpose `files-api`, 10-min TTL on resolved URLs).
- Channel delivery model: OpenClaw fetches bytes from the signedUrl and uploads multipart to each channel API at live-turn time. Live delivery is solved.
- The fact that the SDK owns session.jsonl. OpenClaw cannot patch the SDK or fork it.
- The decision to NOT use inline `⟦file:N⟧` Unicode sentinels emitted by the LLM (LLM-emitted markers are unreliable).

The OPEN question is only how OpenClaw records fileIds during live-turn upload such that the chat-history read path can later resolve them to signed URLs.

---

## §2. The two options

### Option A — Side-channel jsonl

Write a sibling file `<sessionId>.files.jsonl` next to the SDK's `session.jsonl`. Each line:

```json
{
  "ts": "<ISO8601>",
  "responseId": "<turn id>",
  "role": "input|output|tool",
  "fileId": 12345,
  "source": "image-gen-plugin",
  "mediaIndex": 0
}
```

On history serve: read both files, correlate by `responseId`, batch-resolve fileIds, hydrate response.

**Concerns:**

1. Correlation fragility — `responseId`-match can fail if the SDK reorders, compacts, or migrates schema. Position-based fallback is dangerous if the SDK reorders.
2. Crash window — must write side-channel BEFORE fan-out so a crash leaves an orphan side-channel entry pointing at an uploaded file, rather than an uploaded file with no record.
3. Backup/restore — the two files must be backed up + restored together; if they drift, correlation breaks silently.
4. Two files for one logical concern feels operationally wrong.

### Option B — Inline fileId marker in events OpenClaw controls

Encode the fileId directly in the content of events OpenClaw composes BEFORE handing them to the SDK. Rely on the SDK persisting that content verbatim into its session.jsonl.

Proposed marker: `nabu-file://12345` (fake URL scheme; regex-stable `/nabu-file:\/\/(\d+)/`; less collision risk than markdown; compact).

The two event types OpenClaw composes:

- **Tool results** — when a tool returns a file, the tool's text result becomes `Generated image: nabu-file://12345` instead of `MEDIA:/tmp/img-abc.png`.
- **User messages with channel attachments** — when a user posts a photo to Telegram, the composed user message text becomes `[attached: invoice.pdf — nabu-file://12345]\n\nWhat does this PDF say?`.

Assistant (LLM-output) messages stay untouched. The LLM never sees `nabu-file://` in its prompt template, only in tool results that come back from tool calls.

On history serve: read SDK session.jsonl, regex-extract `nabu-file://(\d+)` from event content, dedup, batch-resolve, hydrate.

**Why this might be better:** single file, no cross-file correlation, no crash-window invariant, no backup-pair invariant. fileId is positionally local to the message.

**Why this might fail:** depends entirely on the SDK preserving the marker bytes through its persistence pipeline. Hence the research.

---

## §3. The agent SDK in scope — primary surface

OpenClaw is built on top of **Pi SDK** by Mario Zechner. The packages it consumes:

- **`@mariozechner/pi-coding-agent`** — provides the `SessionManager` class that owns session persistence (`appendMessage()` → writes JSONL line per message)
- **`@mariozechner/pi-agent-core`** — provides the `AgentMessage` type (the event shape that gets serialized to JSONL)
- **`@anthropic-ai/sdk` / `@anthropic-ai/vertex-sdk`** — Pi SDK uses these as inference transports (the actual LLM calls). NOT a persistence layer.

**Primary investigation target:** the Pi SDK packages. The session.jsonl writer lives in `@mariozechner/pi-coding-agent`'s `SessionManager`.

OpenClaw historically referenced "Claude Code agent runtime" and "OpenAI Codex CLI runtime" in earlier coordination — that was wrong. Those are different products. **OpenClaw wraps Pi SDK, not Claude Code or Codex.** Please center the investigation on Pi.

### Where to look first

Pi SDK is published on npm under `@mariozechner/*` and has accompanying public source. Start with:

- npmjs.com pages for `@mariozechner/pi-coding-agent` and `@mariozechner/pi-agent-core`
- Mario Zechner's GitHub (`github.com/badlogic` is one known account — verify) for the Pi SDK repository
- The actual installed source under `node_modules/@mariozechner/pi-coding-agent/` if you have access to a checkout

If a Pi SDK source repo exists publicly, prioritize reading:

- `SessionManager.ts` or equivalent — the JSONL writer
- `AgentMessage` type definitions — the event schema
- Tool result handling — how tool outputs flow through `appendMessage()`

### Secondary scope

If you have spare research time, also briefly survey:

- **Claude Code agent runtime** — Anthropic's CLI agent (`~/.claude/projects/*/sessions/*.jsonl`). Not a direct dependency for OpenClaw, but useful prior art for "agent SDK that writes JSONL session logs."
- **OpenAI Codex CLI / Codex runtime** — if it writes JSONL session logs.
- **Other agent SDKs writing JSONL session logs:** AutoGen, LangGraph checkpointers, Cline, Aider, Goose. Briefly note their persistence model if you can find it.

These are NOT primary. The decision turns on Pi SDK behavior.

---

## §4. OpenClaw-specific code seams (concrete facts from the codebase)

So the research agent understands what "tool result" and "session persistence" mean in OpenClaw's terminology:

### Session path construction

- Function: `resolveSessionTranscriptPath(sessionId, agentId?, topicId?)` at `src/config/sessions/paths.ts:255-261`
- Returns: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
- Base dir helper: `resolveOpenClawAgentDir()` at `src/agents/agent-paths.ts:6-13` (honors env `OPENCLAW_AGENT_DIR` / `PI_CODING_AGENT_DIR`)
- The path structure is unified — does not vary by SDK.

### MEDIA: marker convention (the thing the inline marker proposal would REPLACE)

- Marker shape today: `MEDIA:<localpath>` (e.g., `MEDIA:/tmp/img-abc.png`) or `MEDIA:<http(s)-url>`
- Emitted by built-in tools (exec, edit, apply_patch, browser, canvas) in their stdout
- System prompt instructs the agent to emit it: `src/auto-reply/reply/prompt-prelude.ts`
- Parsed/stripped by `splitMediaFromOutput(raw)` at `src/media/parse.ts:123-293`
  - Regex: `MEDIA_TOKEN_RE = /\bMEDIA:\s*\`?([^\n]+)\`?/gi`
  - Returns `{ text, mediaUrls, mediaUrl, audioAsVoice? }`
  - Validates paths (rejects traversal `../`, home `~`, absolute `/`)
- Applied to tool-result text at `src/agents/pi-embedded-subscribe.handlers.tools.ts:20`

### Tool-result persistence seam (THIS IS THE KEY DISCOVERY)

OpenClaw already has a plugin-hookable wrap around `SessionManager.appendMessage()` that intercepts every message before it's serialized to JSONL.

- File: `src/agents/session-tool-result-guard.ts:76-279`
- Function: `installSessionToolResultGuard(sessionManager, opts)`
- Wraps `sessionManager.appendMessage()` and exposes two hooks:
  - **`transformToolResultForPersistence`** (lines 89-92): tool-result-only transform, called with metadata `{ toolCallId?, toolName?, isSynthetic? }`. Returns the modified message to be persisted.
  - **`beforeMessageWriteHook`** (lines 108-110): generic on-every-message hook, can block or modify any message before write.
- Plugin integration: `src/agents/session-tool-result-guard-wrapper.ts:21-80`
  - `guardSessionManager()` wires the two hooks above into the plugin registry
  - Hook names exposed to plugins: `tool_result_persist` and `before_message_write`
  - Falls back to a no-op `originalAppend` if no plugin registers.

**Flow today:**

```
tool execution
  → toolResult message produced
  → splitMediaFromOutput(toolResult.text)  [media URL extraction]
  → transformToolResultForPersistence hook  [INJECTION POINT — empty by default, plugin-extendable]
  → capToolResultSize()  [size guard]
  → beforeMessageWriteHook  [final gate]
  → originalAppend()
  → SessionManager.appendMessage()
  → JSONL line in session.jsonl
```

**Implication for the research question:** OpenClaw has an existing, supported plugin hook seam to mutate `toolResult.text` BEFORE Pi SDK's `SessionManager` writes it to disk. Implementing Option B requires registering a plugin hook from the new `nabu-files` plugin — no SDK patching, no race window, no cross-file coordination. The question becomes simply: **does Pi SDK's `SessionManager.appendMessage()` persist the message bytes verbatim, and does the round-trip on session reload preserve them?**

### Channel adapter media path (out of scope but relevant for context)

- `OutboundMediaAccess.readFile` at `src/media/load-options.ts` — caller-supplied function
- Channel adapter helper: `src/channels/plugins/outbound/direct-text-media.ts:102, 152` — threads `readFile` through to each channel sender
- Pattern A wrapping happens at the readFile creation site (TBD by OpenClaw PR 1 work, not relevant to this research)

---

## §5. Research questions (prioritized)

### Critical — gate the Option B decision

1. **What is the `AgentMessage` schema in `@mariozechner/pi-agent-core`?** Field names, all message kinds, content shape per kind. Paste the type definition if you can find it.

2. **How does `@mariozechner/pi-coding-agent`'s `SessionManager.appendMessage()` serialize an `AgentMessage` to JSONL?**
   - One line per message (one JSON object), or framed differently?
   - Are any fields stripped, normalized, or transformed on write?
   - Are string fields trimmed, escaped beyond standard JSON encoding, or size-limited?
   - Concrete example: paste 2-3 anonymized real JSONL lines if you can produce them.

3. **For tool results in Pi SDK specifically:** is the `toolResult.text` (or whatever the equivalent field is) persisted as a plain string, verbatim? If we inject `nabu-file://12345` into the tool result text just before `appendMessage`, does the exact substring `nabu-file://12345` appear in the resulting JSONL line?

4. **Does Pi SDK's session load / resume read its own JSONL back?** Pi is described as a "coding agent" SDK — investigate whether it supports session resumption. If yes:
   - Does the round-trip preserve the marker bytes character-for-character?
   - Is there any rewriting/normalization on read?
   - Does it ever rewrite older events (compaction, summarization, schema migration)?

5. **Does Pi SDK have any documented APIs for attaching out-of-band metadata to a message?** E.g., a `metadata: {}` field per `AgentMessage` that the runtime persists but doesn't feed to the LLM. If yes, that's a cleaner alternative to in-text markers.

6. **Tool result size limits.** OpenClaw has its own `capToolResultSize()` truncation step in `src/agents/session-tool-result-guard.ts`. Does Pi SDK ALSO apply an independent truncation downstream? If both truncate, a marker placed near the tail of a long tool result could be silently dropped.

### Important — shapes the marker design

7. **LLM context behavior with unfamiliar URL schemes.** When `nabu-file://12345` appears in a tool result that gets fed back into the LLM's context on the next turn, do modern frontier models (Claude 4.x, GPT-4o, etc.):
   - Ignore it cleanly?
   - Try to fetch/click it?
   - Hallucinate they can resolve it?
   - Echo it correctly into their own response if asked to reference the file?
   - Try to construct guess URLs to other fileIds (prompt-injection-shaped risk)?

8. **Prior art — how do similar projects handle inline fileId-style references in tool results that need to survive into history?**
   - LangChain agents (the various memory backends)
   - AutoGen / LangGraph
   - OpenAI Assistants API (which has native files attachments — does it solve this?)
   - Cline / Aider / Goose / Continue
   - Any project that's solved "tool produces a file → reference it later in chat history" in a TypeScript / Node ecosystem
   - What patterns do they use? Markdown image syntax? Custom URI schemes? Structured content blocks? Native SDK attachment fields?

### Useful — operational concerns

9. **Pi SDK resilience to corruption.** What happens if session.jsonl gets corrupted, partially written, or interrupted mid-event? What's Pi SDK's recovery/rebuild behavior?

10. **Pi SDK schema versioning.** Is the JSONL format versioned? If Pi SDK updates its schema, does it migrate older sessions, fail to load them, or accept old + new side-by-side? This affects how durable our markers will be in long-running sessions.

---

## §6. The decision matrix to fill

For each (SDK, strategy) cell, mark ✅ feasible / ❌ blocked / ⚠️ works-with-caveats. Add a one-line note per cell explaining why.

| Strategy                                      | Pi SDK (primary) | Claude Code (prior art) | OpenAI Codex CLI (prior art) | Other SDK(s) found |
| --------------------------------------------- | ---------------- | ----------------------- | ---------------------------- | ------------------ |
| In-text marker in tool result content         | ?                | ?                       | ?                            | ?                  |
| In-text marker in user message content        | ?                | ?                       | ?                            | ?                  |
| SDK-native attachment / metadata field        | ?                | ?                       | ?                            | ?                  |
| Side-channel jsonl (always works as fallback) | ✅               | ✅                      | ✅                           | ✅                 |

**Decision logic the matrix should support:**

- If Pi SDK supports a native attachment shape → recommend native attachments (best path for OpenClaw)
- If in-text marker works on Pi SDK → recommend inline marker (clean, single-file)
- If neither: side-channel is the only safe option, and we accept the operational complexity, with full rationale documented

---

## §7. What success looks like in your report

A markdown report with these sections, in this order:

1. **Pi SDK schema findings** — `AgentMessage` type, `SessionManager` JSONL format, tool-result persistence shape, user-message persistence shape, native attachment availability. Include real-line examples (anonymized).
2. **Prior-art SDK schema findings** (briefer) — Claude Code, Codex, AutoGen/LangGraph etc. — same shape of info, less depth.
3. **The filled decision matrix from §6.**
4. **Go / no-go recommendation per SDK on the inline marker approach (Option B).** For each "no-go" cell, the failure mode (e.g., "Pi SDK truncates tool results > 16KB silently — markers in long tool outputs would be lost").
5. **If go: marker shape recommendations.** Should we use `nabu-file://12345`, or is there a better convention (markdown link syntax, custom JSON in a metadata field, etc.)?
6. **Prior-art survey** — at least 3 real-world examples of how comparable projects solve this problem, with links.
7. **The synthesized recommendation:** which strategy do you recommend, and what's the fallback if your top recommendation breaks?

Aim for thoroughness over brevity. The cost of an incomplete report is multiple round-trips; the cost of a thorough report is your time once.

---

## §8. Constraints on your investigation

- **Center on Pi SDK** (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`). It's the actual upstream OpenClaw wraps. Other SDKs are useful prior art but not the decision driver.
- **Use primary sources where possible.** Pi SDK source (npm tarball, GitHub repo if public), official docs, real JSONL examples. Hearsay and second-hand summaries are less valuable.
- **It's OK to say "I couldn't find this — would need to instrument an actual session to verify."** If Pi SDK's source isn't publicly accessible, that's itself a useful finding (it constrains us to runtime instrumentation).
- If you find that an SDK's behavior varies by version, note the version you investigated and call out the variance.
- Don't reconsider the locked decisions in §1 ("What's locked"). The backend wire contract is settled and the resolver model is settled. You're only researching OpenClaw's internal persistence choice.

---

---

## §9. Operator notes (REMOVE BEFORE PASTING TO RESEARCH AGENT)

### What's in the codebase right now that you'll want to know

- **No active session.jsonl files on disk** at `~/.openclaw/agents/main/sessions/` — directory exists but is empty (last modified Apr 8 per the file system). You won't be able to attach a real session as a sample. The research agent will have to either find Pi SDK source on its own or work from synthetic examples.
- The hook seam (`session-tool-result-guard.ts`) is real and shipped — if research returns "Option B works," implementation cost is one plugin hook registration, not a new module.
- Earlier coordination rounds (1-8) used "Claude Code / Codex" as the SDK names. That was carried forward in error from a generic "agent SDK" framing. The actual upstream is Pi SDK by Mario Zechner. The research agent needs to know to center on Pi.

### Routing recommendations

- **Claude Opus 4.x via console.anthropic.com with extended thinking + web search** is the strongest single option here — Pi SDK source-reading + npm investigation + prior-art surveys are all suited to its skill set.
- **Perplexity Pro Deep Research** is good for the prior-art survey (§5.8) — run that section as a separate query if you want depth there.
- If you have time/budget, run the same prompt in 2 different research agents and reconcile the answers. SDK internals are easy to get wrong from a single source.

### After research returns

- Post a Round 10 memory entry: "research findings + chosen persistence strategy (inline marker / native attachment / side-channel) + implementation plan."
- Backend agent acks (no decisions on their side — wire contract unchanged either way).
- OpenClaw PR 1 + PR 2 proceed against the chosen strategy.

### Files this prompt references

- Backend memory entry (the original prompt skeleton): hash `db3ff69e5b991483abad52058b8ebba77361916d3455943baad3b24b9e3ebe1b`, tag `round-9-research-prompt`
- OpenClaw memory entry (operator pushback + alternative proposal): hash `a61ae64f4dd3da7f996fe421d78b3ecac6a52cab68f29cbec5ef0658c5cd38e5`, tag `round-9`
- Canonical mental-model memory (full Round 7.5 state): hash `509f500baa42e26c5c868ae09b1a17af9f1b39a9241965164691ba4c9aa1d26d`

If the research agent asks for more context, those three memory entries are the source-of-truth for what came before.
