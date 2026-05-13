# Pi SDK persists tool-result bytes verbatim, and offers a native metadata field that beats inline markers

**Bottom line up front:** Pi SDK (`@mariozechner/pi-coding-agent` v0.73.1) writes one `JSON.stringify`'d entry per line into `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl` with **zero string mutation, normalization, truncation, or schema-driven content rewrites** on either the write or read path. This means Option B (inline `nabu-file://12345` markers in tool-result text) is technically feasible and high-confidence. But the investigation surfaced a strictly better third path: **`ToolResultMessage.details?: any`** — a JSON-serializable metadata bag that Pi persists in JSONL but excludes from LLM context. Use it. The original Option A (side-channel JSONL) and the originally-proposed Option B (inline URI marker) both become unnecessary. The only real-world risk to the `details` approach is third-party `tool_result` extension hooks overwriting it; for fully isolated metadata, Pi also exposes `appendCustomEntry()`, a session-level extension storage that never enters the message stream. The recommendation is **Option C (native `details`) as primary, `appendCustomEntry` as escape hatch, and the originally-proposed inline marker (refactored to an XML tag, not a URI) only if both API surfaces are forbidden**.

---

## 1. Pi SDK schema findings

### The package, the source, and the version anchor

Pi SDK lives in the `badlogic/pi-mono` monorepo on GitHub. The two relevant packages — `@mariozechner/pi-coding-agent` and `@mariozechner/pi-agent-core` — were both at **v0.73.1** at investigation time, MIT licensed. The npm registry's repository URL points back to the same monorepo, and the package's `docs/session-format.md` is the authoritative on-disk spec (412 lines, versioned at `CURRENT_SESSION_VERSION = 3`). All findings below are sourced from `packages/coding-agent/src/core/session-manager.ts`, `packages/coding-agent/src/core/messages.ts`, and `packages/coding-agent/docs/session-format.md`.

### AgentMessage is a tagged union of six variants, all structurally typed

The base `AgentMessage` from `@mariozechner/pi-agent-core` is a union: `UserMessage | AssistantMessage | ToolResultMessage`, extended in `pi-coding-agent` via TypeScript declaration merging to add `BashExecutionMessage | CustomMessage | BranchSummaryMessage | CompactionSummaryMessage`. There is **no `system` role**; the system prompt lives separately in `AgentState.systemPrompt`, not as a persisted message. The full inline shape that matters for this decision:

```ts
interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[]; // ALWAYS an array of blocks
  details?: any; // <-- persisted, not sent to LLM
  isError: boolean;
  timestamp: number;
}
interface TextContent {
  type: "text";
  text: string;
}
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
```

The critical structural fact: **tool result `content` is always an array of typed blocks** (Anthropic-style), never a flat string. `UserMessage.content` may be either a flat string or a block array. Both `ToolResultMessage` and `CustomMessage` carry an opaque, free-form **`details?: any` field that survives JSONL round-trip but is explicitly excluded from `convertToLlm()`** when the runtime later sends messages to the model. Pi's docs describe `details` as "tool-specific metadata — not sent to the LLM."

### SessionManager.appendMessage is essentially `JSON.stringify + appendFileSync`

The write path is mechanically simple:

```ts
appendMessage(message): string {
  const entry = { type: "message", id: generateId(...), parentId: this.leafId,
                  timestamp: new Date().toISOString(), message };
  this._appendEntry(entry);          // pushes in-memory + persists
  return entry.id;
}
_persist(entry) {
  // ...buffering caveat: defers writes until first assistant message exists...
  appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
}
```

**No field stripping, no text trimming, no escaping beyond standard JSON encoding, no size limit, no normalization, no fsync.** Records are LF-delimited (the RPC docs explicitly warn clients not to use `readline`-style splitters that also break on U+2028/U+2029). Once written, entries are append-only — `_rewriteFile()` is only invoked on schema migration or on first-write into an empty/corrupted file. One operational wrinkle worth noting: **writes are buffered in memory until the first `assistant` message arrives**, then flushed in a single batch. A crash before the first assistant turn loses unflushed entries; tool-result entries are normally preceded by an assistant `toolCall`, so this corner rarely matters in practice but is worth knowing.

### The read and resume path is also pass-through

`loadEntriesFromFile()` does `JSON.parse` per line, silently skipping malformed lines, and validates only that the first record is a session header. `buildSessionContext()` walks the entry DAG from a chosen leaf to the root and **pushes the parsed `entry.message` reference into the messages array verbatim** — no transform. `convertToLlm()` (the function that produces the message array sent to the LLM) returns `user`, `assistant`, and `toolResult` messages **unchanged**; only the pi-coding-agent extension variants (`bashExecution`, `custom`, `branchSummary`, `compactionSummary`) are wrapped into synthetic user messages. **A `TextContent.text` string written into a tool result round-trips through write→read→re-feed-to-LLM byte-for-byte.**

### Schema migrations exist, but they don't touch content payloads

Pi has run two migrations historically: v1→v2 added `id`/`parentId` to every entry; v2→v3 renamed the `hookMessage` role to `custom`. Both rewrite the file once on load via `_rewriteFile()`. **Neither migration ever touches `message.content` strings, `text` fields, or `details`** — they edit the entry envelope and legacy role names only. Markers (in either text or `details`) survive every documented migration trivially. Compaction is a different beast: it appends a new summary entry and `buildSessionContext` then hides messages prior to `firstKeptEntryId` from the LLM's view, but **the original tool-result entries remain on disk indefinitely**. The marker is preserved as a disk artifact even after the live LLM context replaces it with a summary string.

### Real example JSONL line for a tool result

From `docs/session-format.md`:

```json
{
  "type": "message",
  "id": "c3d4e5f6",
  "parentId": "b2c3d4e5",
  "timestamp": "2024-12-03T14:00:03.000Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_123",
    "toolName": "bash",
    "content": [{ "type": "text", "text": "output" }],
    "isError": false
  }
}
```

The same line with Option B (inline URI marker) injected:

```json
{"...","message":{"role":"toolResult","toolCallId":"call_123","toolName":"image_gen","content":[{"type":"text","text":"Generated image: nabu-file://12345"}],"isError":false}}
```

And the same line with Option C (native `details`):

```json
{"...","message":{"role":"toolResult","toolCallId":"call_123","toolName":"image_gen","content":[{"type":"text","text":"Generated image."}],"details":{"nabuFileIds":[12345]},"isError":false}}
```

All three forms round-trip verbatim. The third never appears in the model's context window.

### The one real-world risk is `tool_result` extension hooks

Pi exposes a documented extension event (variously called `tool_result` or `afterToolCall`) whose return type is `ToolResultEventResult { content?, details?, isError? }`. **Any registered extension can replace `content`, `details`, or `isError` before persistence.** A recent CHANGELOG entry (`#3051`) confirms `details`/`isError` overrides are now correctly forwarded through `AgentSession`. This is the dominant operational risk for both Option B and Option C: a context-pruning or content-rewriting extension in the user's installed extension set could strip a marker or overwrite `details`. OpenClaw's own existing `transformToolResultForPersistence` and `beforeMessageWriteHook` seams in `session-tool-result-guard.ts` are this exact hook surface — which means OpenClaw controls whether any other extension can clobber its markers, simply by registering its `nabu-files` plugin and being aware of write order. No SDK-level risk; an in-house ordering concern.

---

## 2. Prior-art SDK persistence (briefer)

**Claude Code (Anthropic CLI agent)** writes JSONL at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, append-only, one Anthropic-format `message` per line, with a Claude-Code-specific sidecar field `toolUseResult` carrying structured metadata next to each tool-result line. It has **no native file-reference primitive**: images and tool-produced files are inlined as base64 `image` blocks, which is a well-documented production anti-pattern (issues #43056, #29273, #16592 — "Request too large" failures and irrecoverable sessions). The Claude Code precedent confirms two things relevant here: an SDK can carry app-defined structured metadata as a sibling JSON field alongside the wire-format message, and inlining bytes (rather than references) breaks at scale.

**OpenAI Codex CLI** writes JSONL "rollouts" at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Each line is `{timestamp, type, payload}` where `type` discriminates `response_item`, `event_msg`, `turn_context`, etc. Tool results land in `payload.type == "function_call_output"` as a free-form `output` string. OpenAI recommends truncating tool outputs to ~10k tokens, but truncation is caller-side. There is no per-message attachment field; idiomatic file references would be a custom `type: "file_artifact"` event line.

**OpenAI Assistants API** is the strongest prior art for native attachments. Messages carry a structured `attachments: [{file_id, tools}]` array, content blocks include `{type: "image_file", image_file: {file_id}}`, and Code Interpreter outputs auto-emit a parallel `annotations[]` table mapping `(start_index, end_index, text) → file_path.file_id`. **The user-visible text contains a `sandbox:/mnt/data/<name>` URI; the canonical file_id lives in a sibling structured field.** This is the closest live precedent for the originally-proposed `nabu-file://12345` pattern — and its documented UX failure mode is severe: the `sandbox:` URI leaks into third-party UIs (LibreChat, OpenWebUI, Make.com) where users try to click it and fail. The lesson: if a marker is visible to the model, the model **will** echo it to users.

**Secondary projects** confirmed the same patterns at lower depth. **LangGraph** checkpointers store typed message blobs in SQLite/Postgres/memory and its docs explicitly warn against inlining file bytes in state ("store the URL/ID in state, not the file"). **AutoGen 0.2** used inline `<img path-or-URL>` tags inside the user prompt string — a direct precedent for an XML-tag marker shape. **AutoGen 0.4** uses typed Python message objects with no on-disk format. **Cline** stores three JSON files per task (`api_conversation_history.json`, `ui_messages.json`, `task_metadata.json`) with no native attachment field; files are inlined as Anthropic image blocks. **Aider** writes Markdown directly to `.aider.chat.history.md` with no structured reference layer. **Goose** moved from JSONL to SQLite at v1.10; its tool-call rows are structured but file artifacts remain text-embedded. **Continue.dev** has no documented file-reference field and exports sessions as Markdown.

**The cross-project consensus is two-pronged.** Systems that control their persistence layer (OpenAI Assistants, MCP `resource_link` blocks, Goose's structured rows) use native attachment/file_id fields. Systems forced to operate through free-text channels (Claude Code, AutoGen 0.2, Aider) inline markers — sometimes URIs, sometimes XML, sometimes Markdown — and pay a complexity tax. **Pi SDK falls into the first camp**: it has the `details` slot, OpenClaw should use it.

---

## 3. Decision matrix

| Strategy                                   | Pi SDK (primary)                                                                                                                                                                                                       | Claude Code (prior art)                                                                                                                                          | OpenAI Codex CLI (prior art)                                                        | OpenAI Assistants API                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| In-text marker in tool result content      | **Feasible** — content round-trips verbatim; survives migrations and writes; LLM sees it. Risk: third-party `tool_result` extensions; compaction hides from live context but preserves on disk.                        | Feasible — tool_result content is free-form string or blocks, no transforms documented. Risk: base64 image bloat unrelated.                                      | Feasible — `function_call_output.output` is a free-form string.                     | Works with caveats — visible URI in `output_text` is exactly OpenAI's `sandbox:/mnt/data/` pattern, which leaks to end users.                |
| In-text marker in user message content     | Feasible — `UserMessage.content` accepts string or blocks; both round-trip.                                                                                                                                            | Feasible — same as tool result.                                                                                                                                  | Feasible — `input_text` is free-form.                                               | Feasible — text content blocks are free-form.                                                                                                |
| **SDK-native attachment / metadata field** | **Feasible and strictly cleaner** — `ToolResultMessage.details?: any` is JSON-serializable, persisted to JSONL, never sent to LLM. `CustomMessage.details` and `appendCustomEntry()` give two further isolation tiers. | Not native — but Claude Code's own `toolUseResult` sibling field shows the SDK tolerates structured app metadata at the entry envelope level (not standardized). | Not native in the canonical schema; would need a custom `type` line in the rollout. | **Best-in-class** — `message.attachments: [{file_id, tools}]`, `content[].image_file.file_id`, `metadata` bag (16 keys, 64/512 char limits). |
| Side-channel JSONL (Option A fallback)     | Feasible but unnecessary — `details` makes side-channel obsolete unless extension ecosystem clobbers it.                                                                                                               | Feasible.                                                                                                                                                        | Feasible.                                                                           | Not relevant (server-side storage).                                                                                                          |

---

## 4. Go / no-go on Option B (inline URI marker)

**Pi SDK: GO with caveats** — the persistence layer preserves the marker bytes exactly. The only failure modes are (i) a third-party `tool_result` extension that rewrites `content`, and (ii) compaction-boundary crossing, which keeps the marker on disk but replaces the live LLM context with a summary. Both modes also apply to Option C. **Option B is, however, dominated by Option C**: every operational property of Option B is matched or exceeded by `details`, and Option C eliminates LLM-visibility risks entirely.

**Claude Code: GO** — same persistence-layer story; no transformations on tool result content. The marker would round-trip, but Claude Code's session format is irrelevant to OpenClaw and shown only as prior art.

**OpenAI Codex CLI: GO** — `function_call_output.output` is a free-form string.

**OpenAI Assistants API: AVOID for inline URI specifically** — the `sandbox:/mnt/data/` precedent shows that any URI-shaped marker visible to the model will be echoed into user-visible replies, where downstream clients render it as a broken link. Use the API's native `file_ids`/`attachments` instead.

Beyond Pi SDK persistence, the LLM-behavior research surfaced a meaningful **inline-URI-specific failure mode**: modern frontier models (Claude 4.x, GPT-4o, GPT-5) echo URI-shaped tokens faithfully into output, and downstream chat clients with permissive Markdown renderers can turn `[label](nabu-file://12345)` or `![alt](nabu-file://12345)` into clickable links or load attempts. This is the same class of bug as the documented Markdown-exfiltration vulnerabilities that have hit Slack AI, ChatGPT, Claude iOS, Microsoft Copilot, GitHub Copilot, Google Antigravity, Devin, GitLab Duo, and others. **The marker shape, not the persistence layer, drives this risk** — and it's avoidable by either (a) using the non-visible `details` field, or (b) if going inline, using an XML self-closing tag rather than a URI scheme.

---

## 5. If forced to go inline, use an XML tag, not a URI

Across six candidate marker shapes evaluated for actionable-render risk, hallucination risk, echo fidelity, token cost, and regex stability, the **self-closing XML tag** wins cleanly:

| Shape                                         | Actionable risk               | Hallucination risk                                             | Echo fidelity                                           | Notes                                                               |
| --------------------------------------------- | ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| `nabu-file://12345` (URI scheme)              | Medium — looks like a URL     | Medium — adjacent-ID guessing plausible under attacker prompts | High                                                    | Collides with the `sandbox:/mnt/data/` failure family               |
| `![file 12345](nabu-file://12345)` (MD image) | **High** — invites image-load | Medium                                                         | Medium                                                  | Matches known exfil-attack syntax exactly. **Don't.**               |
| `[file 12345](nabu-file://12345)` (MD link)   | High — clickable              | Medium                                                         | Medium                                                  | Same exfil family.                                                  |
| `<nabu-file id="12345"/>` (XML)               | **Low — not a URL**           | Low — Claude trained to treat XML as structural                | **High**                                                | Aligns with Anthropic's documented XML prompt-engineering guidance. |
| `⟦file:12345⟧` (bracket sentinel)             | Low                           | Low                                                            | Medium — non-ASCII may be tokenizer-fragile             | Closest to OpenAI's `【18:0†source】` citation sentinel.            |
| `{"file_id": 12345}` (JSON)                   | Low (inside structured block) | Low (matches native pattern)                                   | High inside structured block; low embedded in free text | Best if the tool result is purely structured.                       |

**The XML-tag form (`<nabu-file id="12345"/>`) wins** on three concrete grounds: it is not a navigable URL so no chat-client renderer will try to dereference it; Claude is trained to read XML as a structural delimiter (Anthropic explicitly recommends XML for separating data from instructions); and the regex `<nabu-file\s+id="(\d+)"\s*/>` is unambiguous. Cost is ~10 tokens. Failure mode if the model paraphrases the tool result heavily: the tag may be dropped — mitigation is a system-prompt directive to preserve tags verbatim. Avoid the Markdown image and link forms entirely; they reproduce the exfiltration attack pattern.

---

## 6. Synthesized recommendation

**Primary recommendation: implement Option C — `ToolResultMessage.details: { nabuFileIds: number[] }`.** Wire OpenClaw's new `nabu-files` plugin into the existing `transformToolResultForPersistence` hook in `session-tool-result-guard.ts`, populate `details.nabuFileIds` with the freshly-uploaded fileIds at upload time, and on history reload read `entry.message.details.nabuFileIds`, dedup, batch-resolve via `/skill-resolve`, hydrate the `fileRefs[]` response. This path has every property the original side-channel design was trying to achieve, with none of the operational complexity:

- **Single source of truth.** No sibling file. No backup-pair invariant. No correlation by `responseId`. The fileId is positionally bound to the message that produced it because it's a literal field on that message.
- **No crash window.** The marker is persisted by the same `appendFileSync` call that persists the message itself. Atomic at the line level.
- **Invisible to the LLM.** `convertToLlm()` strips `details`. No token cost, no echo risk, no Markdown-renderer collision, no `sandbox:/mnt/data/`-style UX leak.
- **Structured, not text-parsed.** No regex, no escaping edge cases, no marker-near-truncation-boundary risk.
- **Verbatim round-trip is verified from primary source** through write → JSONL → parse → `buildSessionContext` → optional `convertToLlm`, with no transformations at any stage and migrations that touch only envelope fields.

**Fallback ladder if `details` is contested.** If audit of the installed Pi extensions reveals any third-party `tool_result` hook that overwrites `details` (or if OpenClaw wants belt-and-suspenders isolation): use `SessionManager.appendCustomEntry(customType, data)` to write a session-level `CustomEntry` line that `buildSessionContext` ignores entirely and that no `tool_result` hook is wired to mutate. This is one tier more isolated than `details` and matches Claude Code's `toolUseResult` sibling-field pattern. The cost is correlation by `parentId`/`toolCallId` instead of struct-field colocation — slightly worse than `details` but still strictly better than the original Option A side-channel because everything stays in one JSONL file with shared schema and shared atomic write semantics.

**Secondary fallback if both API surfaces are forbidden.** Inline marker in the tool-result `TextContent.text` field, using the **XML self-closing form `<nabu-file id="12345"/>`** rather than the originally-proposed URI scheme. Round-trip survives verbatim; risk is bounded to the marker becoming model-visible and being preserved by the model in echoed output, which is acceptable as long as OpenClaw's outbound renderer either strips the tag from user-facing text or escapes the `<` for display.

**Reject the originally-proposed side-channel JSONL.** Every concern listed in §2 of the brief (correlation fragility, crash window, backup-pair invariant, operational "two files for one concern") evaporates when the marker lives on the same JSONL line as the message that produced it. The side-channel pattern was a reasonable design under the assumption that the SDK might mangle injected content; that assumption is false for Pi SDK.

**One thing the research could not fully verify without runtime instrumentation:** whether any per-provider adapter inside `@mariozechner/pi-ai` reshuffles tool-result content blocks on the live send path to the LLM API. The persistence path is unambiguously pass-through; the live send path through `convertToLlm` is also pass-through for `toolResult`; but the very last hop (the OpenAI/Anthropic provider client formatting blocks for the wire) was not exhaustively audited for every provider. This affects only Option B and only the LLM's view of the marker on the next turn — the persistence guarantee on which the decision turns is unaffected. If absolute certainty is required, run `npm pack @mariozechner/pi-coding-agent@0.73.1` and grep the `dist/` output for any `text.replace`, `truncate`, or `slice` call paths that touch tool-result content; one afternoon of work.

## Conclusion

The decision is no longer between Option A and Option B. The research changed the option space. Pi SDK's `JSON.stringify`-and-flush write path with no transformations means any content OpenClaw puts on an `AgentMessage` will survive — but more importantly, Pi already ships the exact API surface this problem needs: a typed metadata field on tool results that persists but doesn't enter the LLM context. **Use `ToolResultMessage.details`; wire it through OpenClaw's existing `transformToolResultForPersistence` hook; keep `appendCustomEntry` as the escape hatch.** The originally-proposed URI marker can be retired; if any inline path is later forced by an extension-ecosystem conflict, the XML-tag form replaces the URI form and avoids the entire Markdown-exfiltration risk family that has burned every major LLM vendor at least once since 2023.
