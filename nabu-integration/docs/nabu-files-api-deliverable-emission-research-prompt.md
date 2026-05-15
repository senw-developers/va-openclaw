# Files API — Agent-Produced File Deliverable Emission: Architecture Research Prompt

> **For:** External AI research agent (Claude Opus with web search, Perplexity Deep Research, Gemini with grounding).
>
> **From:** `va-openclaw` (a TypeScript wrapper around the Pi SDK, `@mariozechner/pi-coding-agent`) integrated with a NestJS Files API backend (`va-core-nest`).
>
> **Self-contained:** the research agent has no access to our source or coordination memory. Everything needed is in this prompt. Code paths are cited as *evidence we have already gathered*, not as files you can open — use them to calibrate your answer, not to look anything up.
>
> Copy §1 through §8 verbatim into the research agent. §9 ("Operator notes") is for the human routing this prompt and should be removed before pasting.
>
> **Framing note (important):** Do **not** treat any approach sketched here as the intended answer. We deliberately want you to explore the full solution space — including reusable, centralized, single-interception-point designs we may not have considered — and recommend what is genuinely best, even if it contradicts our instincts. Optimizing for "one place to maintain" over "edit every tool" is explicitly desirable if it is sound.

---

## §1. What I'm researching and why

We have a **fully working** media delivery pipeline for *tool-generated* media in OpenClaw. When the agent calls the first-class `image_generate` (or `video_generate`, `music_generate`) tool, the produced file is uploaded to a backend Files API, gets a durable `fileId` + fresh signed URL, and is surfaced to the frontend as a structured `fileRefs[]` field. This is verified end-to-end in production for images.

The problem: **this only works for the handful of tools that explicitly emit a media envelope.** When the agent produces *any other kind of file* — a CSV, XLSX, DOCX, PDF, a generated report, a zip — by running a script via the `bash` tool (e.g. Python with `openpyxl` / `python-docx` / `reportlab` / `csv`), the file is written to the workspace and the agent simply **describes the path in prose**. It never enters the delivery pipeline. The user sees "saved to: /home/node/.openclaw/workspace/test_data.csv" — a path inside a container they cannot reach — and there is no download.

I need a recommended architecture for **reliably turning arbitrary agent-produced files into deliverables** across our delivery surfaces, **without** having to special-case every current and future tool. A centralized interception point is one hypothesis; you should evaluate it against alternatives and propose the best design, including any you originate.

## §2. System context (the parts that already work)

- **Runtime:** OpenClaw wraps Pi SDK (`@mariozechner/pi-coding-agent`). The agent runs a tool loop; each tool produces a `ToolResultMessage` with `content` (LLM-visible) and `details` (persisted to the session JSONL transcript verbatim, excluded from the LLM context window).
- **Upload pipeline:** A Pi `tool_result` extension intercepts tool results, finds media candidates, uploads them to the backend (`POST /v1/files-api/skill-upload`), stamps durable ids into `details.nabuFileIds`, and rewrites the result so downstream consumers get a signed URL. A companion resolver re-issues fresh signed URLs on history reload. **This whole pipeline is content-type agnostic** — it will upload a `.csv` or `.xlsx` exactly as happily as a `.png`; MIME is derived from the file extension. The pipeline is *not* the gap.
- **The media envelope convention:** First-class generator tools emit their output as `MEDIA:<path>` lines in the tool result text (evidence: `image-generate-tool.ts:673` maps each saved image to `` `MEDIA:${image.path}` ``; `video-generate-tool.ts:589`, `music-generate-tool.ts:444` do the same). A parser (`splitMediaFromOutput` in `src/media/parse.ts`) extracts **only** lines whose trimmed start is exactly `MEDIA:` — and ignores fenced code blocks. The upload extension also reads `details.media.{mediaUrl,mediaUrls}`.

## §3. The exact problem, with a concrete reproduction

Real transcript from the live system (frontend web chat, surface = OpenResponses HTTP):

```
User: generate a CSV file (test file)
Agent: Your CSV test file has been created at:
       /home/node/.openclaw/workspace/test_data.csv
       It contains 10 rows of sample employee data ...

User: now generate an excel file
Agent: Your Excel file has been created at:
       /home/node/.openclaw/workspace/test_data.xlsx ...

User: now generate a word file
Agent: Your Word document has been created at:
       /home/node/.openclaw/workspace/test_data.docx ...
```

In every case the agent shelled out via `bash` (Python scripts), wrote a real, correct file to the workspace, and narrated the absolute path. None of these became downloadable. Contrast: "generate an image" works perfectly, because `image_generate` is a dedicated tool that auto-emits the `MEDIA:` envelope.

## §4. What we have already verified in our codebase (do not re-derive this)

This is settled. Use it as ground truth so your research focuses on the *solution*, not the diagnosis:

1. **No general file-producing tool exists.** Only `image/video/music_generate` auto-emit `MEDIA:`. There is a `pdf-tool` but it is a PDF *reader/analyzer* (takes input PDFs, runs a prompt) — it does not generate or emit deliverables.
2. **`bash` is deliberately skipped by the upload extension.** The extension's built-in skip set is `{bash, read, edit, write, grep, find, ls}`. These tools run constantly and produce huge amounts of incidental filesystem activity (code edits, temp files, logs, intermediate data). Blanket-uploading their outputs is explicitly considered unsafe (noise, leakage, Files API flooding).
3. **Prose paths are not envelopes.** A sentence containing `/home/node/.openclaw/workspace/test_data.csv` is not a `MEDIA:` line, so `splitMediaFromOutput` correctly ignores it. The model is not currently instructed to emit `MEDIA:` for files it creates by hand.
4. **A native channel-delivery primitive exists but is unused here.** The `message` tool accepts `mediaUrl` / `filePath` / `path`, and is *not* in the skip set — so a file delivered through it *would* flow through the pipeline. But (a) the agent isn't choosing to use it for script-produced files, and (b) the `message` tool targets *messaging channels* (Telegram/Slack/etc.), not the web/OpenResponses surface the user is actually on.
5. **Downstream is ready.** Once a file is surfaced as a media candidate (via `MEDIA:` or `details.media`), everything after that — upload, durable id, signed-URL refresh, `fileRefs[]` to the frontend, channel fan-out — already works for any content type.

**Conclusion already reached:** this is an *emission/behavioral* gap, not missing infrastructure. The open question is purely: *what is the best mechanism to get arbitrary agent-produced files emitted as deliverables, reliably, without per-tool churn?*

## §5. The two delivery surfaces (a correct answer must address both)

1. **Web chat via OpenResponses HTTP** (`/v1/responses`, SSE). This is where the user reproduced the bug. Delivery contract here = `MEDIA:` envelope in the assistant/tool output → upload pipeline → `response.completed.fileRefs[]` (and per-message `fileRefs[]` on history reload). There is **no** channel `message` tool involved on this surface.
2. **Messaging channels** (Telegram, Slack, Discord, iMessage, WhatsApp, MS Teams). Delivery is via the outbound reply pipeline / `message` tool with `mediaUrl`/`filePath`.

A good design should ideally unify these, or at minimum work cleanly for #1 (the failing case) without breaking #2.

## §6. Constraints and non-negotiables

- **No per-tool edits as the primary strategy.** Adding `MEDIA:` emission to every tool that might write a file (and every future one) is the status quo's failure mode generalized. We strongly prefer a reusable/centralized mechanism. If you conclude per-tool is genuinely the only sound option, you must justify why centralization is unsafe.
- **Must not leak or flood.** `bash`/`write` produce code, temp files, logs, intermediate artifacts. A solution that uploads "every new file" is unacceptable unless it has a robust, defensible signal for "this is a user-intended deliverable" (explicit intent, designated output location, allowlist + caps, or similar). Discuss the signal quality of whatever you propose.
- **Prompt-cache stability.** OpenClaw treats turn-to-turn prompt prefix stability as correctness-critical. Any approach that rewrites transcript history or injects nondeterministic content into the model context is high-risk; call this out if relevant.
- **Pi SDK lifecycle reality.** Interception points are: per-tool result (`tool_result` extension event, async, result-mutating), transcript persistence hooks, and the reply/output assembly layer. The model's *final assistant message* is also a candidate surface (the model already narrates the path — perhaps that narration can be made structured/parseable, or the model steered to emit the envelope, or a post-turn step can reconcile workspace state with intent). Evaluate interception at each layer.
- **Plugin boundary.** Extensions may only cross into core via documented SDK seams; core must stay extension-agnostic. A centralized solution should respect this (it may live in core as a generic capability, or as a Pi extension, but not as a hardcoded special-case list).
- **Security posture for testing/CTF-style content is fine; this is a legitimate product feature** (users asking the assistant to produce documents they can download).

## §7. What I want from you (open-ended)

Recommend the architecture you would actually build. Do not feel bound by anything above except the §6 constraints. In particular, explore and compare at least:

- A **centralized deliverable-detection layer** (e.g. a single interception point that recognizes intended output files regardless of which tool produced them — via workspace diff with intent signals, a designated output directory the agent is told to use, structured tool-call metadata, post-turn reconciliation of the model's stated path against the filesystem, etc.). What is the strongest *intent signal* available, and how reliable is it?
- A **single explicit delivery tool** the agent is taught to call for any file it wants the user to have (the `image_generate`-style envelope pattern, generalized once). Trade-off: depends on model compliance; mitigations?
- **Model steering** (system-prompt contract: "emit `MEDIA:<abspath>` for any file the user asked you to produce"). How robust is this empirically across frontier models in 2025–2026? What's the failure rate and how to harden it?
- **Hybrid** designs (e.g. explicit tool as the happy path + a gated post-turn reconciliation as a safety net).
- Any **prior art**: how do comparable agent runtimes / coding-agent frameworks (Pi/`pi-coding-agent`, Claude Code, OpenAI Assistants/Code Interpreter file outputs, Devin, Open Interpreter, Cline, aider, E2B, etc.) handle "the agent produced a file the user should be able to download"? What is the dominant pattern, and why? Is there an emerging convention we should align with rather than invent?

For your recommended approach, specify: the interception point(s), the intent signal and its false-positive/false-negative profile, behavior on the OpenResponses web surface specifically, interaction with prompt-cache stability, security/leakage analysis, and a rough implementation sketch. Also state explicitly what you would *not* do and why.

## §8. Deliverable format

Produce a single self-contained markdown document:

1. **Executive recommendation** (≤200 words): the one architecture you'd build and the single sentence of why.
2. **Solution space analysis**: each viable approach, with a comparison table (robustness, intent-signal quality, leakage/security risk, prompt-cache impact, web-surface coverage, maintenance surface, model-compliance dependence, effort).
3. **Recommended architecture in depth**: interception point(s), control flow, the intent signal, edge cases (multiple files, large files, binary vs text, agent overwrites, agent produces then deletes, files outside workspace), and how it behaves on both delivery surfaces.
4. **Prior-art summary**: what other agent frameworks do, with the takeaway.
5. **Risks and what you would not do.**
6. **Implementation sketch**: concrete enough that an engineer can start, framed against the lifecycle interception points in §6.

Be decisive. We will treat your executive recommendation as the default plan unless its own analysis argues otherwise.

---

## §9. Operator notes (remove before pasting to the research agent)

- Strip this section before sending.
- Companion context (do not paste, for our own reference): prior research that produced "Option G" lives in `nabu-integration/docs/nabu-files-api-upload-trigger-research-result.md`; the full integration state is in remote memory save-points `814aa8a5…` and follow-up `78b12a1f…`.
- The honest internal lean is "centralized detection + explicit delivery tool hybrid," but we intentionally did not encode that as the answer here — we want the researcher to challenge it. If the result strongly recommends pure model-steering, pressure-test the empirical compliance claim before acting.
- Surfaces to keep in mind when reading the result: OpenResponses HTTP (`/v1/responses`) is the failing one; the `message`-tool/channel path already mostly works and should not regress.
