# Deliverable manifest: making every agent-written file a first-class artifact

## 1. Executive recommendation

**Build a single explicit `deliver` tool as the happy path, backed by a centralized post-turn reconciliation extension that auto-promotes files written under a designated `/workspace/out/` directory or explicitly named in the assistant's final message — gated by an intent allowlist, never mutating already-sent tool results, and surfaced as a sidecar `fileRefs[]` on the response (web) or reply assembly (channels).** This is the team's "centralized detection + explicit delivery tool hybrid" lean, validated by prior art at OpenAI, Anthropic, MCP, LangChain, and AutoGen, and by published evidence that no frontier model in 2026 follows a free-text marker rule reliably enough across hundreds of turns to be the sole mechanism.

The reasons in one sentence each: explicit-tool gives the model a structured affordance that matches the dominant industry pattern (OpenAI `container_file_citation`, MCP `resource_link`, LangChain `content_and_artifact`); centralized reconciliation closes the gap the explicit tool will inevitably leak (MMMT-IF measured a 17-point absolute drift in format-rule compliance from turn 1 to turn 20 on 2024-class frontier models, and OpenAI's own forums document the same path-narration failure mode); the intent signal of "in `/workspace/out/`, or named in the final assistant message, or explicitly delivered" is empirically separable from incidental bash filesystem noise; and Pi's `tool_result` and `turn_end` events let this run cache-safely without ever rewriting transcript history.

## 2. Solution space analysis

The team enumerated five families. Each is real, each has a place in the design, but only one combination satisfies every §6 constraint.

**A. Per-tool `MEDIA:` emission (status-quo generalized).** Every file-producing tool — present and future — is patched to emit a `MEDIA:` line. This is what currently works for `image_generate`/`video_generate`/`music_generate`. It fails the §6 "no per-tool edits as primary strategy" test by construction. It also doesn't solve `bash`, the actual failing tool, because `bash` is a general-purpose primitive: there is no `bash` patch that distinguishes user-deliverables from log files, temp files, and intermediate data without an intent signal — and once you have an intent signal, you no longer need the per-tool patch.

**B. Pure model steering ("emit `MEDIA:<abspath>` for any file you create").** Cheap, no infrastructure. But the empirical evidence is unequivocal: **IFEval saturates around 95% on frontier 2026 models**, implying a ~5% per-turn miss rate even on simple format rules; **MMMT-IF (Google DeepMind, arXiv 2409.18216)** measured **Programmatic Instruction Following dropping from 0.81 at turn 1 to 0.64 at turn 20** on Claude 3.5 Sonnet, GPT-4o, and Gemini 1.5 Pro — and the underlying attention-decay mechanism is structural, not fixed in any 2025–2026 release; **Code-IF (arXiv 2507.00699)** found hard-satisfaction rate for hierarchical format constraints collapsing from 54.5% (single) to 18.8% (multi-constraint) on Claude 3.7 Sonnet. OpenAI's own developer forum carries multiple reports of Code Interpreter losing `container_file_citation` annotations when the model narrates a path in prose instead of citing it — the *exact* OpenClaw bug, reproduced inside OpenAI's flagship product. There is no published number for "emit literal marker every time across hundreds of turns" specifically, but the proxies all point the same way. **Verdict: viable as a hint, not as the contract.**

**C. Single explicit delivery tool (`deliver`).** Generalizes the `image_generate` envelope pattern once. The model must opt in by tool-calling. This is the **dominant industry pattern** for server-side coding agents: OpenAI Assistants/Responses route every Code Interpreter file through a model-emitted `sandbox:/mnt/data/...` link that the server resolves to a `file_path`/`container_file_citation` annotation; MCP defines `resource_link` content blocks as the standard way for any tool to mark an output as user-facing; LangChain's `response_format="content_and_artifact"` returns a `(content, artifact)` tuple where artifact is server-side and explicitly not LLM-visible; Devin exposes a presigned-URL attachments API. The depend-on-model-compliance risk is real but bounded: tool calls have far higher adherence than free-text markers (Anthropic strict tool-use reports ~99.8% schema match in third-party measurements, OpenAI Structured Outputs claims 100% via constrained decoding), and a missed call surfaces as a *missing file* the user can ask for again — not as silent data loss inside structured output.

**D. Centralized infrastructure-driven detection (workspace diff + intent signal).** The Anthropic Code Execution tool's approach: server-side enumeration of files created during a tool call, surfaced as `BashCodeExecutionOutputBlock` entries with `file_id` and a `downloadable: true` provenance flag on the Files API. Robust against model non-compliance. Requires a defensible intent signal to avoid uploading `node_modules`, build artifacts, and temp files. Implementable in Pi via a `tool_result` extension that watches `/workspace` between `turn_start` and `turn_end`, gated by an intent filter. **Verdict: necessary as a safety net, insufficient as the sole mechanism** — the intent-signal problem is genuinely hard for general bash output without some form of opt-in from the model or the user.

**E. Hybrid (C + D).** The happy path is the explicit `deliver` tool; the safety net is centralized reconciliation. The model gets a clean opt-in primitive; infrastructure catches the cases where the model narrates a path in prose instead of calling the tool; intent signals (designated output directory, explicit mention in final assistant message, allowlist) prevent flood. **This is the recommended architecture.**

### Comparison table

| Approach | Robustness | Intent signal quality | Leakage/security risk | Prompt-cache impact | Web-surface coverage | Maintenance surface | Model-compliance dep. | Effort |
|---|---|---|---|---|---|---|---|---|
| A. Per-tool `MEDIA:` | Low — fails on new tools and on `bash` | N/A (tool-specific) | Low | None if mutation pre-emission | Yes for patched tools | High (every tool) | Medium | High (recurring) |
| B. Pure model steering | Low — ~5% per-turn miss, drifts to 20–40% by turn 50+ | Weak (model-internal) | Low | None | Yes when model complies | Low | **Critical** | Trivial |
| C. Single explicit `deliver` tool | Medium-high — tool-call adherence >> free-text markers | Strong (model opt-in) | Very low | None (mutation in `tool_result`) | Yes | Low | High but lower-risk than B | Low |
| D. Centralized workspace diff | High when intent signal is strong | Depends on signal | Medium without allowlist; low with | None if results emitted in `tool_result` of a `reconcile_deliverables` synthetic tool, OR as a sidecar outside the LLM transcript | Yes | Low (one extension) | Zero | Medium |
| **E. Hybrid C + D (recommended)** | **High** | **Strong (multi-signal)** | **Low** | **None** | **Yes** | **Low** | **Medium, tolerant of failure** | **Medium** |

## 3. Recommended architecture in depth

### Interception points

Two, one for the happy path and one for the safety net, both inside the SDK's documented extension lifecycle.

**Primary: a new built-in or pre-registered `deliver` tool**, plugged into the `tool_result` middleware chain. When the agent calls `deliver({path, name?, mime?, description?})`, the tool: validates the path exists, lives under the workspace root, is not in the ignore set; computes size/mime; emits a tool-result whose `content` is a human-readable confirmation ("Delivered report.pdf — 142 KB") and whose `details` carries a structured `{deliverables: [{path, name, mime, size, sha256}]}` record. The existing upload extension, whose skip set is `{bash, read, edit, write, grep, find, ls}`, sees `deliver` (not in the skip set), reads `details.deliverables[]`, uploads to `/v1/files-api/skill-upload`, stamps `details.nabuFileIds`, and rewrites the result to include a fresh signed URL. **This entire flow stays cache-safe because mutation happens inside `tool_result`, which fires *before* the tool-result message is persisted and *before* the next provider request** (confirmed in `packages/coding-agent/docs/extensions.md`: "Fired after tool execution finishes and before `tool_execution_end` plus the final tool result message events are emitted. Can modify result.").

**Secondary: a `deliverables-reconciler` extension** that subscribes to `turn_start`, `tool_result` (read-only observe), and `turn_end`. At `turn_start` it begins a chokidar watch scoped to `/workspace` excluding the ignore set. At `turn_end` it has the set of files created or modified this turn (`createdThisTurn`). It applies the intent filter described below. For survivors not already delivered via the `deliver` tool this turn, it uploads them through the same Files API pipeline and **attaches them to the outbound reply assembly as a sidecar**, not by rewriting any prior tool result.

### The intent signal — ranked and stacked

A single signal is brittle. The reliable design stacks four, ordered by precedence:

1. **Explicit `deliver` tool call** (highest precedence, lowest false-positive). The model said "this file is a deliverable" by calling the tool. Trust completely.
2. **File written under `/workspace/out/`** (designated output directory). System prompt teaches the agent: "If a user asks you to produce a file they will download, write it under `/workspace/out/`. Other locations are scratch." Compliance for "use this directory" is materially better than for free-text markers because it aligns with the model's existing affordance (it writes files anyway; only the location changes), and edit-style work naturally stays in place (which is correct — we don't want to ship src/app.ts as a deliverable). **Verdict: strong positive signal; very low false-positive rate** because nothing else writes to `out/`.
3. **File path mentioned by absolute path in the final assistant message AND the file exists AND extension is in the deliverable allowlist** (CSV, XLSX, DOCX, PDF, ZIP, TXT, JSON, MD, PNG, JPG, MP4, MP3, etc.). Path-regex extraction from the assistant's final text, cross-checked against the filesystem. False-positive rate low after the existence check; covers the exact failing transcript ("saved to /home/node/.openclaw/workspace/test_data.csv"). False-negative rate high in isolation (model often summarizes without listing paths), which is why it's a secondary signal not a primary one.
4. **Created-this-turn AND under `/workspace/out/` AND not in ignore set** — derived from chokidar between `turn_start` and `turn_end`. The created-this-turn constraint plus the directory constraint plus the ignore set together produce a near-zero false-positive rate.

A file qualifies as a deliverable if it satisfies (1) OR (2) OR ((3) AND created/modified this turn). Files satisfying only "created this turn" but not in `out/` and not mentioned by path are **deliberately ignored** — this is the §6 "must not leak or flood" guarantee. A user who asked for a file but got nothing can retry; the worse failure mode is leaking source code or temp data, which is non-recoverable.

### Behavior on both delivery surfaces

**Web chat via OpenResponses HTTP.** The upload extension already stamps `details.nabuFileIds` on the `deliver` tool's result; the existing response-completed assembly already aggregates `fileRefs[]` from `details.nabuFileIds` across all tool results in the turn and emits `response.completed.fileRefs[]`. So the explicit-tool path *just works* on the web surface without additional code. The reconciler's safety-net deliveries are merged into the same `fileRefs[]` aggregation at response-completion time, treated as if they came from a synthetic `reconcile_deliverables` tool result — but, critically, this synthetic record is attached only to the **outbound response payload**, not to the LLM-visible transcript that gets cached and re-sent next turn. The model never sees the reconciler's findings.

**Messaging channels (Telegram/Slack/Discord/iMessage/WhatsApp/Teams).** The existing reply pipeline reads `details.nabuFileIds` and attaches files to the channel-native message. The `deliver` tool's results flow through this path unchanged. For the reconciler's safety-net deliveries, the same sidecar emit point at reply assembly works: each deliverable becomes an attachment on the outgoing channel message. The current `message` tool's `mediaUrl`/`filePath`/`path` parameters remain valid for the explicit-channel-targeted case and continue to work.

### Edge cases

**Multiple files in one turn.** `deliver` accepts a single path per call; the model calls it N times for N files. The reconciler emits an array. The Files API and `fileRefs[]` already handle N.

**Large files.** Enforce a size cap (default 100 MB, configurable) at `deliver` and at reconciler. Files exceeding the cap are not uploaded; the tool returns an error the model can surface; the reconciler logs and skips. The cap protects the Files API from accidental zip-of-node-modules cases.

**Binary vs text.** Irrelevant to the architecture — MIME is derived from extension at upload time, and the upload pipeline is already content-type agnostic per §2 of the brief.

**Agent overwrites a file.** Both `deliver` (explicit call) and reconciler (chokidar `change` event) see the latest content. SHA256 in the `details` record lets downstream consumers detect overwrites if they care. The Files API gets a fresh `fileId` per upload — old IDs remain valid via the signed-URL resolver until TTL.

**Agent produces then deletes.** Chokidar sees `add` then `unlink`; reconciler ignores files that don't exist at `turn_end`. `deliver` called against a now-missing path returns an error.

**Files outside workspace.** `deliver` rejects paths not under the workspace root (security). The reconciler's chokidar watch is scoped to `/workspace` and never sees them.

**`MEDIA:` markers inside fenced code blocks.** The existing parser handles this (line-anchored `trimStart().startsWith("MEDIA:")` per the corrected `splitMediaFromOutput` in `dist/deliver-Dlw-4HTg.js` around line 1606, per OpenClaw issue #17141). Continue to use that parser for the legacy media-generator tools. The new path uses `details.deliverables[]` directly and bypasses text parsing.

**Branching / session forking.** The reconciler keys its per-turn state on `(sessionId, turnIndex)` so a branched session restarts with a fresh chokidar baseline.

**Cache stability.** Both `deliver` tool results and reconciler-sidecar emissions are produced before the next provider request and never retroactively rewrite a previously-sent tool_result. The Anthropic prompt cache (5-min default TTL, 1-hour extended, ~12.5× cost penalty on a miss, full invalidation from any byte change in the cached prefix) sees a stable transcript prefix turn over turn. **Do not** attempt to attach durable file IDs into already-emitted tool results via a transcript-persistence hook — Pi's extension API doesn't support it (`sessionManager` is read-only to extensions) and forcing it via out-of-band JSONL rewrites would invalidate cache from the rewritten turn forward.

## 4. Prior-art summary

For server-side coding agents — OpenClaw's category — the industry has converged on **explicit-marker hybrid**. OpenAI Assistants and Responses both depend on the model emitting `sandbox:/mnt/data/<file>` markdown links that the server post-processes into `file_path` or `container_file_citation` annotations on the assistant message; this is the documented, supported pattern, and it has the *same failure mode* OpenClaw is hitting: when the model writes a file but narrates the path in prose instead of citing it, the file is unreachable, reported in multiple OpenAI developer-community threads. ChatGPT consumer uses the identical scheme.

MCP, the emerging cross-vendor protocol, defines `resource_link` and `EmbeddedResource` content blocks in tool results: typed structured records carrying URI, name, mimeType, size, and an `annotations.audience: ["user"|"assistant"]` flag that explicitly distinguishes "for the human" from "for the model." This is a direct schema match for what OpenClaw's `details.deliverables[]` should be. The pattern is in the 2025-11-25 spec revision and the host (not the LLM) is responsible for resolving the URI to a deliverable surface — which is exactly the team's reply-assembly seam.

LangChain's `response_format="content_and_artifact"` returns a `(content, artifact)` tuple where the artifact rides on `ToolMessage.artifact` and is explicitly excluded from the LLM context window. This maps 1:1 onto Pi's `(content, details)` split, where `details` is "persisted to JSONL, excluded from LLM context" — the OpenClaw team already has the right shape; it just needs a `details.deliverables[]` convention to formalize it.

AutoGen takes the designated-directory route: each code executor has a `work_dir`; `CommandLineCodeResult.code_file` and `JupyterCodeExecutor.output_files` enumerate what was produced. The system prompt tells the model "if your code creates an image, the output will be a path to the image instead of the image itself" — same intent-signal philosophy as `/workspace/out/`.

The **purely infrastructure-driven** counterexample is Anthropic's hosted Code Execution tool: the sandbox server enumerates files Claude wrote and emits them in `bash_code_execution_tool_result.content` as `BashCodeExecutionOutputBlock` records with `file_id` and a `downloadable: true` provenance flag distinguishing agent-created from user-uploaded. The model does not have to opt in. This is the cleanest design *if you control the sandbox completely*, which OpenClaw essentially does — and is the validating prior art for the safety-net reconciler.

IDE-native agents (Cline, aider, Cursor, Replit, Open Interpreter, Goose) are not relevant comparisons: they don't have a deliverable problem because the user *is* in the workspace; the file is already on the user's disk.

**Takeaway:** the team's instinct to combine an explicit delivery primitive with centralized detection is precisely the dominant industry pattern, and the two strongest validators (OpenAI's hybrid + Anthropic's Code Execution provenance) jointly endorse the hybrid. The team is not inventing; they are aligning.

## 5. Risks and what I would not do

**Do not rely on pure model steering for the `MEDIA:` envelope as the sole mechanism.** The published evidence — MMMT-IF's 17-point turn-to-turn drift, Code-IF's collapse under multi-constraint pressure, OpenAI Code Interpreter's known prose-narration bug, IFEval's hard 95% ceiling — makes this empirically indefensible across hundreds of turns. Use it as a hint inside the system prompt (telling the agent to call `deliver` and to write to `out/`), never as the contract.

**Do not patch every tool to emit `MEDIA:`.** This is the per-tool maintenance treadmill §6 forbids, and it can't solve `bash` (no per-tool patch can distinguish deliverable from log file without an intent signal).

**Do not mutate already-emitted tool results retroactively to inject file IDs.** Pi's extension model doesn't permit it (`sessionManager` read-only to extensions per `docs/extensions.md`), and forcing it via JSONL rewrites would catastrophically invalidate the Anthropic prompt cache (~12.5× cost penalty per affected turn; see Anthropic prompt-caching docs, §"What invalidates the cache"). All file-ID stamping must happen inside the `tool_result` middleware *of the originating tool call*, before persistence, before the next provider request.

**Do not auto-upload every file written by `bash`/`write`.** §6 forbids this and it's right to forbid it: `npm install`, `git checkout`, build steps, log writes, and editor temp files would flood the Files API and leak source code. The skip set `{bash, read, edit, write, grep, find, ls}` exists for exactly this reason. The reconciler must apply the intent filter; the filter is the architectural crux.

**Do not regex absolute paths out of the assistant message as a primary signal.** Coverage is too poor (models often summarize without listing paths) and false positives appear from example paths in code fences. It's a useful tertiary signal, not a primary one.

**Do not put detection logic inside the LLM-visible cached prefix.** Run reconciliation in an extension whose output flows to the response-assembly layer, not back into the transcript the next turn's prompt is built from.

**Be cautious about a "post-turn LLM reconciliation second pass" that asks the model "which of these files are deliverables?".** It works (1–3s latency, ~$0.001–0.01/turn with a small model) but it adds a network dependency and a new failure surface for a problem that's already 95% solved by the deterministic intent filter. Consider it only if false-positive/false-negative metrics in production show the deterministic filter is materially wrong.

## 6. Implementation sketch

The work splits into four concrete pieces against the Pi SDK lifecycle interception points documented in `packages/coding-agent/docs/extensions.md`.

**Piece 1 — the `deliver` tool.** Register a new tool whose name is `deliver` (not in the upload extension's skip set, so its results flow through `tool_result`). Schema: `{path: string, name?: string, mime?: string, description?: string}`. Implementation in TypeScript:

```ts
async execute({path, name, mime, description}, ctx) {
  const abs = pathlib.resolve(WORKSPACE_ROOT, path);
  if (!abs.startsWith(WORKSPACE_ROOT)) throw new Error("outside workspace");
  if (isIgnored(abs)) throw new Error("path is in ignore set");
  const st = await fs.stat(abs);
  if (st.size > MAX_SIZE) throw new Error(`exceeds ${MAX_SIZE}B`);
  const sha = await sha256File(abs);
  const mt = mime ?? mimeFromExt(abs);
  return {
    content: `Delivered ${name ?? pathlib.basename(abs)} (${humanSize(st.size)})`,
    details: { deliverables: [{ path: abs, name: name ?? pathlib.basename(abs),
                                mime: mt, size: st.size, sha256: sha,
                                description }] }
  };
}
```

Update the system prompt with one paragraph: *"When the user asks you to produce a file they should be able to download (CSV, XLSX, DOCX, PDF, ZIP, etc.), write it to `/workspace/out/` and call the `deliver` tool with the absolute path. Do not narrate paths in prose alone — the user cannot reach the container filesystem and will not see the file unless you call `deliver`."*

**Piece 2 — extend the upload extension to read `details.deliverables[]`.** Today it reads `MEDIA:` lines from text content and `details.media.{mediaUrl,mediaUrls}`. Add a third reader: `details.deliverables[]`. For each entry, upload via `POST /v1/files-api/skill-upload`, stamp `details.nabuFileIds`, attach the durable id + signed URL into the result. This is a ≤30-line addition to the existing extension.

**Piece 3 — the `deliverables-reconciler` extension.** New extension, single file. Subscribes:

- `agent_start`: initialize chokidar with `{ignored: IGNORE_GLOBS, ignoreInitial: true, awaitWriteFinish: {stabilityThreshold: 300, pollInterval: 50}}` scoped to `/workspace`. `IGNORE_GLOBS` includes `node_modules/**`, `.git/**`, `dist/**`, `.cache/**`, `*.log`, `*.tmp`, `*~`, `.DS_Store`, `.next/**`, `target/**`. Ensure container has `fs.inotify.max_user_watches=524288`.
- `turn_start`: record `turnStartTime = Date.now()`; reset per-turn buffer of created/modified paths.
- `chokidar('add'|'change')`: push `{path, kind, t: Date.now()}` into the buffer.
- `tool_result`: observe-only; record which paths were already delivered via `deliver` this turn (read `event.result.details.deliverables[].path`) so reconciler doesn't double-emit.
- `turn_end`: compute the candidate set as `bufferThisTurn − alreadyDeliveredPaths`. Apply intent filter:
  - **Keep** if path starts with `/workspace/out/`.
  - **Keep** if absolute path appears verbatim in `event.message` (the final assistant text) AND extension ∈ `DELIVERABLE_EXTENSIONS` AND `fs.existsSync(path)`.
  - **Drop** otherwise.
  - For each survivor: upload via the same `/v1/files-api/skill-upload`, get `{fileId, signedUrl, mime}`, emit into the outbound response/reply-assembly layer as a synthetic `fileRefs[]` entry tagged `source: "reconciler"`. **Do not** rewrite any persisted tool result.

The "emit to outbound response" call site is downstream of Pi (in OpenClaw's `runEmbeddedPiAgent` / `consumeReplyDirectives`, per the integration docs at docs.openclaw.ai/pi). For the OpenResponses surface, append to `response.completed.fileRefs[]`. For channel surfaces, hand off to the same reply assembler that the `message` tool feeds.

**Piece 4 — observability.** Log every reconciler decision with `{turnId, path, decisionReason, signal}`. After a week in production you have an empirical false-positive/false-negative profile and can tune `IGNORE_GLOBS`, the path-mention regex, and `DELIVERABLE_EXTENSIONS`. If the deterministic filter shows >5% error rate, gate-add the optional Haiku-sized post-turn reconciliation LLM pass behind a feature flag.

**Migration path for the legacy `MEDIA:`-emitting tools.** No breaking change. The existing `splitMediaFromOutput` parser (line-anchored `trimStart().startsWith("MEDIA:")` per OpenClaw `dist/deliver-Dlw-4HTg.js`#~L1606) continues to operate on tool-output text. The new path runs in parallel via `details.deliverables[]`. Over time, port `image_generate`/`video_generate`/`music_generate` to also populate `details.deliverables[]` for cleaner cross-tool consistency, but neither the upload extension nor the response assembler needs the legacy parser removed.

**Effort estimate.** Piece 1: half a day. Piece 2: half a day. Piece 3: two to three days (chokidar plumbing, intent filter, reply-assembly integration, tests). Piece 4: one day. Total: roughly one engineering week to a robust, observable, hybrid pipeline that closes the bash-produced-file gap on both delivery surfaces, respects every §6 constraint, and aligns with the dominant industry pattern.

## Conclusion

The team's internal lean survives scrutiny: a centralized detection layer + an explicit delivery tool is the right shape, and the architectural debt of building it now is small compared to the cost of either (a) chasing per-tool `MEDIA:` patches in perpetuity, or (b) trusting a model-steering rule whose published compliance numbers tell us it will silently drop files at a measurable rate over long sessions. The non-obvious move is the **intent signal stack** — explicit tool → designated `/workspace/out/` → mentioned-in-final-message → created-this-turn — which is what separates a leakproof reconciler from an unsafe "upload everything bash touched" footgun. Anthropic's hosted Code Execution tool shows the infrastructure-driven version of this works at scale when you control the sandbox; OpenAI's Code Interpreter shows the explicit-marker version works at scale when the model cooperates; the hybrid catches both classes of failure with one extension, on one interception point, with no transcript mutation and no prompt-cache risk.