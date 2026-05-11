# OpenResponses Inline Media Delivery

> **⚠️ REVERTED on 2026-05-11.** This approach did not work in practice
> (1 MB cap killed video/large images; transcripts bloated; no persistent
> URL across history reloads). The rollback procedure in §6 was applied:
> `src/gateway/openresponses-media.ts` deleted, all 4 call sites in
> `src/gateway/openresponses-http.ts` restored to pre-hack state.
> The follow-on design — a dedicated NestJS Files API modeled on
> Anthropic's Files API — is briefed in
> [nabu-files-api-research-prompt.md](./nabu-files-api-research-prompt.md).
> This document is kept for historical context only.

**Status:** ~~shipped~~ **reverted 2026-05-11** — see banner above
**Date:** 2026-05-08 (shipped) → 2026-05-11 (reverted)
**Scope:** `src/gateway/openresponses-http.ts` + new `src/gateway/openresponses-media.ts`
**Net diff:** +138 LOC (new file) + ~75 LOC modifications across 4 call sites in 1 file
**Owner:** openclaw repo
**Rollback risk:** low — surgical, additive change with no new infra

---

## 1. Why this exists

### The problem

The OpenResponses HTTP API (`POST /v1/responses`) is the primary delivery surface for our web frontend. Its output schema only carries text-shaped items (`message` with `output_text` content parts and `function_call`). It has no native carrier for binary or attachment output.

Tools that produce media — `image-generate-tool`, `video-generate-tool`, `music-generate-tool`, `tts-tool` — all emit a `MEDIA:<absolute-path>` marker in their tool-result text. Channel adapters (Slack/Telegram/Discord/iMessage/MS Teams) intercept those markers and convert them into native attachments by **reading the file off disk and pushing the bytes to that channel's own service**. The OpenResponses pipe had no such adapter, so two things broke:

1. **Path leakage:** the `MEDIA:/home/node/.openclaw/media/.../<uuid>.png` line passed through the agent untouched into `output_text`, leaking the container's internal filesystem layout to the end user. Even the agent itself sometimes echoed it ("I saved your file to `/home/node/.openclaw/workspace/...`").
2. **No actual delivery:** even when the agent did the right thing and didn't mention paths, the file bytes never reached the browser. There was no URL to fetch from, no static file server, nothing.

The `MEDIA:` line was also being **silently stripped** before reaching `output_text` in some code paths (`splitMediaFromOutput` in `src/media/parse.ts`), so naive client code couldn't even fall back to "read the path off the response."

### The audit trail

Two parallel audits were run before deciding the approach:

- **Codebase agent** confirmed: OpenResponses output schema is text-only; the strip-and-discard pipeline silently throws away `data.mediaUrls`; no nabu-* plugin currently registers HTTP routes; the orphaned `src/media/host.ts` + `src/media/server.ts` is a near-fit but uses a separate Express port and Tailnet hostnames; no shared HTTP-upload helper exists in any plugin.
- **Industry research** confirmed: OpenAI Responses API has only `image_generation_call` (base64) and `container_file_citation` annotations; OpenResponses spec defers binary output to vendor extensions; ChatGPT/Claude both deliver via signed URLs on dedicated user-content domains (`files.oaiusercontent.com`, `claudeusercontent.com`); MCP endorses both inline base64 and URL-by-reference for binary; no industry-standard `output_file` exists.

Three options were on the table. We picked **Option α (inline data URI in `output_text`)** for v1.

| Option | Verdict | Reason |
|---|---|---|
| α — inline `data:` URIs in `output_text` | **chosen** | Smallest viable change; no new infra; works for images and small docs |
| β — gateway-served signed URL via `ensureMediaHosted` | parked | Needed for video; adds ~145 LOC + nginx route; no infra payoff yet |
| γ — route through NestJS + MinIO | parked | Production-correct end state; needs NestJS module + MinIO wiring; revisit when per-org retention/audit is required |

The forward path: when video is in scope or transcript bloat becomes a real problem, swap the body of `renderInlineMediaMarkdown` for a hosted-URL minter. **All call sites in `openresponses-http.ts` stay identical**.

---

## 2. What changed

### New file: `src/gateway/openresponses-media.ts`

Three exports, all pure-function-shaped:

| Export | Purpose |
|---|---|
| `collectMediaUrlsFromPayloads(payloads)` | Order-preserving dedup of `mediaUrl` (legacy) + `mediaUrls` (modern) fields across an array of `ReplyPayload`-shaped objects |
| `renderInlineMediaMarkdown(mediaUrls, opts?)` | Turns paths/URLs into markdown. HTTP/S URLs pass through as `![](url)`. Local paths are read, MIME-sniffed, base64-encoded, and emitted as `![](data:...)` (images) or `[basename](data:...)` (other types). Oversize/unreadable entries are silently dropped — they are never echoed back |
| `appendInlineMediaToText(text, payloads, opts?)` | Convenience composer: `text + "\n\n" + rendered` when there's anything to append, otherwise `text` unchanged |

Configuration:
- `OPENRESPONSES_INLINE_MAX_BYTES` env var, default **1 MB** per file.
- Files larger than the cap are silently skipped (not echoed as a path, not converted to a hosted URL — that's Option β).

Dependencies: `node:fs`, `node:path`, and the existing `detectMime` helper from `src/media/mime.ts`. No new external dependencies.

### Modified file: `src/gateway/openresponses-http.ts`

Four call sites in one file. All four assemble final assistant text from `result.payloads[]` and now also pass that text + payload list through `appendInlineMediaToText`.

| # | Path | Site (approx line) | Mechanism |
|---|---|---|---|
| 1 | Non-stream tool-call short-circuit | ~728 | After computing `baseAssistantText`, call `appendInlineMediaToText` and use its return as `assistantText` for the assistant `output_item` |
| 2 | Non-stream normal completion | ~768 | After computing `baseContent`, call `appendInlineMediaToText` and use its return as `content` for the assistant `output_item` |
| 3 | Streaming tool-call short-circuit | ~1046 | After computing `baseText`, call `appendInlineMediaToText`. If the result grew, emit an extra `response.output_text.delta` for the appended segment, then `output_text.done` with the final text |
| 4 | Streaming normal completion + no-deltas fallback | inside `maybeFinalize` (~838) | New `finalizeMediaPayloads` is captured right after `runResponsesAgentCommand` resolves (~1031). `maybeFinalize` was promoted to `async`; it now awaits `appendInlineMediaToText(finalizeRequested.text, finalizeMediaPayloads)` and emits a delta + `done` with the augmented final text |

Two type widenings inside `openresponses-http.ts`:
- `payloads` cast from `Array<{ text?: string }>` → `Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>`. Field names match the pre-existing `ReplyPayload` shape from `src/auto-reply/types.ts:151-175`. No new type definitions; we reuse what the rest of the codebase already produces.
- `maybeFinalize` signature went from sync `() => void` to `async () => Promise<void>`. The two call sites of `maybeFinalize()` were updated to `void maybeFinalize()` so we don't accidentally float a rejection.

### What was NOT changed

- ❌ No changes to any tool (`image-generate-tool`, `video-generate-tool`, `music-generate-tool`, `tts-tool`) — they keep emitting `MEDIA:<absolute-path>` lines as before.
- ❌ No changes to any channel adapter — Slack/Telegram/etc. continue to read the path and push to their own services unchanged.
- ❌ No changes to `splitMediaFromOutput`, `MEDIA_TOKEN_RE`, or any other media-parsing logic.
- ❌ No new HTTP routes, no nginx config, no NestJS endpoints, no MinIO wiring.
- ❌ No new plugin.
- ❌ No changes to OpenResponses output schema (still `output_text` + `function_call`).
- ❌ No changes to spawn-seed `openclaw.json` for this work specifically. (Other unrelated config edits in that file are tracked separately.)

### Test status at time of merge

`pnpm test src/gateway/openresponses-http.test.ts` ran 16 tests:
- **15 passed** — including every test that exercises the four modified paths:
  - `preserves assistant text alongside non-stream function_call output` (path 1)
  - `handles OpenResponses request parsing and validation` (path 2)
  - `falls back to payload text for streamed function_call responses` (path 3)
  - `streams OpenResponses SSE events` (path 4)
- **1 failed** — `aborts agent command when non-streaming client disconnects`. Pre-existing flake. The failure is upstream of the modified code (`agentCommand` was never called), times out identically when run in isolation, and the suite ran for 173s with `afterAll` hitting its 120s hookTimeout — environmental, not regression.

A standalone smoke test of the helper logic (9 cases: dedup, empty payloads, HTTP URL passthrough, missing-path drop, image-as-data-URI, text-file-as-link, oversize-drop, mixed-handling) passed 9/9.

---

## 3. End-to-end behavior

### Before the change

```
Agent calls image_generate
   ↓
image-generate-tool returns:
   { content: [{ type: "text", text: "Generated 1 image with minimax/image-01.\nMEDIA:/home/node/.openclaw/media/tool-image-generation/abc.png" }],
     details: { paths: ["/home/.../abc.png"], media: { mediaUrls: [...] } } }
   ↓
Agent's reply text contains the MEDIA:/home/... line
   ↓
splitMediaFromOutput strips the MEDIA: line and forwards path into payload.mediaUrls
   ↓
OpenResponses pipe reads payload.text only — DISCARDS payload.mediaUrls
   ↓
Browser sees: assistant text WITHOUT the media line, no file delivered
```

The agent often hallucinates a path back into its own user-visible reply ("I saved your image to /home/node/...") to compensate for the apparent loss, which is the path-leak symptom.

### After the change

```
Agent calls image_generate                                    (unchanged)
   ↓
image-generate-tool returns the same MEDIA:/home/... line     (unchanged)
   ↓
splitMediaFromOutput strips MEDIA: line into payload.mediaUrls (unchanged)
   ↓
OpenResponses pipe NOW ALSO reads payload.mediaUrls, calls
appendInlineMediaToText:
   - reads /home/.../abc.png from disk
   - detects MIME image/png
   - if size ≤ 1 MB: appends `\n\n![](data:image/png;base64,...)` to output_text
   - if size > 1 MB: silently drops (path NEVER echoed back)
   ↓
Browser markdown renderer turns ![](data:image/png;base64,...)
into <img src="data:..."> automatically
```

Channel adapters (Slack/Telegram/etc.) are still on the old path: they consume `payload.mediaUrls` directly, push to their own service, no change. Behavior parity is preserved.

### Streaming-mode timing

Streaming has four branches that all converge on the same logic:

1. **Per-delta events** are unchanged — the agent's text deltas stream through `response.output_text.delta` in real time. `mediaUrls` are not in the delta stream by design (they're aggregated into payloads at lifecycle end).
2. **`runResponsesAgentCommand` resolves** → `result.payloads` is captured into the new `finalizeMediaPayloads` variable.
3. **Tool-call short-circuit:** if the agent ended on a tool call, `finalText` is built from accumulated text or payload text, then media is appended, then a single delta + `done` are emitted with the augmented text.
4. **Normal completion** (with deltas or via no-deltas fallback): the lifecycle:end event triggers `requestFinalize`. Inside `maybeFinalize`, the captured `finalizeMediaPayloads` are appended to `finalizeRequested.text`. If the result grew, an append-only `output_text.delta` is emitted before `output_text.done`, so streaming clients' accumulated text matches the final.

Append-only delta semantics are important: clients that buffer deltas to reconstruct the final text must observe `final_text === sum(deltas)`. The new code preserves that invariant.

### Failure modes (intentional)

- **File missing on disk** (deleted between save and OpenResponses assembly): silently dropped from output. The agent text may say "Generated 1 image" without an image link, but no path or error is leaked.
- **File larger than `OPENRESPONSES_INLINE_MAX_BYTES`** (default 1 MB): silently dropped. Same UX as missing file. Future Option β will swap this to a hosted-URL fallback.
- **MIME detection fails:** falls back to `application/octet-stream`, emits as `[basename](data:...)`, never as `![](...)`. Browser will offer a download instead of trying to render.
- **Empty `payloads` array** (no tool produced media): helper returns input text unchanged. No-op.
- **HTTP URLs** (e.g., already-hosted media): pass through as `![](url)` without inlining. Forward-compatible with future Option β / γ.

---

## 4. Configuration

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `OPENRESPONSES_INLINE_MAX_BYTES` | `1048576` (1 MB) | Files larger than this are silently dropped from the OpenResponses output. Must be a positive integer; non-numeric values fall back to the default. |

### No new openclaw.json keys

Deliberately. We avoided adding a config key for v1 to keep the rollback surface minimal. If we need per-tenant tuning later, add a `gateway.openresponses.inlineMaxBytes` key and read it via `api.runtime.config.loadConfig()`.

---

## 5. Verification recipe

To confirm the change is working in a deployed instance:

### Manual smoke

```bash
# In an instance with image generation configured (e.g. Minimax):
docker compose exec openclaw-cli node dist/index.js agent --agent main \
  --message "Generate a small test image of a red square."

# Watch the gateway logs:
docker compose logs -f openclaw-gateway 2>&1 | grep -i "openresponses\|MEDIA:"
```

Then from the frontend or `curl`:

```bash
curl -s -X POST http://localhost:18789/v1/responses \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "openclaw", "input": "Generate a small test image of a red square.", "stream": false}' \
  | python3 -m json.tool | head -50
```

**Expected:** the response's `output[0].content[0].text` contains the assistant's prose followed by `![](data:image/png;base64,...)`. **Not** a `/home/node/...` path.

### Streaming smoke

```bash
curl -N -X POST http://localhost:18789/v1/responses \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "openclaw", "input": "Generate a small test image.", "stream": true}'
```

**Expected:** a series of `response.output_text.delta` events (text chunks), eventually followed by **one final `response.output_text.delta` whose `delta` starts with `\n\n![](data:image/png;base64,`**, then `response.output_text.done` with the full augmented text, then `response.completed`.

### Failure-mode smoke

Force a missing-file scenario by manually deleting the file between generation and response:

```bash
# In one shell: tail the media dir
watch -n 0.5 ls -la $OPENCLAW_CONFIG_DIR/media/tool-image-generation/

# In another: send the request
# Race-delete the file as soon as it appears:
rm $OPENCLAW_CONFIG_DIR/media/tool-image-generation/<uuid>.png
```

**Expected:** the OpenResponses payload still completes successfully, just without the data-URI block. No path is leaked in the response. No error is thrown.

---

## 6. Rollback procedure

The change is **fully reversible by reverting two files**. There are no DB migrations, no infra changes, no deployed callbacks to coordinate. Rollback is safe at any time.

### Quick rollback (one command)

If the change has been merged to a single commit on `main`:

```bash
git revert <commit-sha>
```

If it landed across multiple commits, identify the range:

```bash
git log --oneline -- src/gateway/openresponses-media.ts src/gateway/openresponses-http.ts
git revert <oldest-sha>^..<newest-sha>
```

### Manual rollback (precise)

If a partial rollback is needed (e.g., keep the helper file but disable inlining), or if the revert lands on a conflicting branch:

**File 1: delete** `src/gateway/openresponses-media.ts` entirely.

**File 2:** in `src/gateway/openresponses-http.ts`, undo:

1. **Import line near top** (~line 57):
   - REMOVE `import { appendInlineMediaToText } from "./openresponses-media.js";`

2. **Non-stream payloads cast** (~line 717):
   - REVERT `payloads` cast back to:
     ```ts
     const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
     ```

3. **Non-stream tool-call short-circuit** (~line 728):
   - REVERT `baseAssistantText` rename and remove the `appendInlineMediaToText` call. Restore:
     ```ts
     const assistantText =
       Array.isArray(payloads) && payloads.length > 0
         ? payloads.map((p) => (typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n\n")
         : "";
     ```

4. **Non-stream normal completion** (~line 768):
   - REVERT `baseContent` rename. Restore:
     ```ts
     const content =
       Array.isArray(payloads) && payloads.length > 0
         ? payloads.map((p) => (typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n\n")
         : "No response from OpenClaw.";
     ```

5. **Stream-mode state declaration** (~line 833):
   - REMOVE the `finalizeMediaPayloads` declaration (the comment and the `let`).

6. **`maybeFinalize` function** (~line 836–893):
   - Change `const maybeFinalize = async () => {` back to `const maybeFinalize = () => {`.
   - REMOVE the `appendInlineMediaToText` call and the append-only delta block.
   - Change all four occurrences of `finalText` back to `finalizeRequested.text` in the SSE events and `createAssistantOutputItem`.

7. **`requestFinalize`** (~line 926):
   - Change `void maybeFinalize();` back to `maybeFinalize();`.

8. **Stream IIFE post-await** (~line 1031):
   - REVERT `resultAny` cast to `{ payloads?: Array<{ text?: string }>; meta?: unknown }`.
   - REMOVE the `finalizeMediaPayloads = ...` line.

9. **Stream tool-call short-circuit** (~line 1046):
   - REVERT `baseText` rename. Restore the original `finalText` assignment.
   - REMOVE the `appendInlineMediaToText` call and the append-only delta block.

10. **Stream `void maybeFinalize()`** (~line 1140):
    - Change `void maybeFinalize();` back to `maybeFinalize();`.

After steps 1–10, verify with `git diff` that the file matches the pre-change state.

### What rollback gets you back

- ❌ Path leak in OpenResponses returns. Tools again emit `MEDIA:/home/node/...` paths that may surface in the agent's text reply.
- ❌ Files not delivered to OpenResponses clients. Browser clients see no image/file.
- ✅ Channel adapters keep working unchanged (they were never affected).
- ✅ No data loss anywhere — the change is stateless.
- ✅ No follow-up cleanup needed. No new files exist on disk because of this change. No new env vars need un-setting (they have default-as-off behavior).

### Partial rollback options

- **Disable inlining without removing code:** set `OPENRESPONSES_INLINE_MAX_BYTES=0`. Every file then exceeds the cap and is silently dropped. Equivalent UX to full rollback for the OpenResponses pipe, while leaving channel adapters fully unaffected.
- **Lower the cap:** set a smaller value (e.g., `131072` for 128 KB) to limit transcript bloat without disabling.
- **Per-instance disable:** the env var is read on every call (no module-level caching), so setting it in the per-instance `.env` and `docker compose restart openclaw-gateway` flips the behavior.

---

## 7. Known limitations

| Limitation | Impact | Mitigation / next step |
|---|---|---|
| Files >1 MB are silently dropped | Video and large PDFs don't surface to OpenResponses clients today | Implement Option β (gateway-served signed URL) when video is in scope; one helper-body swap |
| Data URIs persist in agent session log | Each delivered image is base64-stored in the assistant's reply transcript on disk (`~/.openclaw/agents/<id>/sessions/*.jsonl`) | Acceptable at current image volumes; if it becomes a disk-pressure issue, schedule session-log compaction or migrate to URL approach |
| No per-org retention/audit/billing on delivered files | All of these are absent | Migrate to NestJS-routed (Option γ) when these become customer requirements. Helper boundary stays the same |
| `previous_response_id` continuation: the agent's text history retains data URIs | Slight context cost on each turn — the model "sees" the prior image bytes inline | Negligible for typical sizes; agent-side compaction handles long sessions |
| Streaming append-only delta is emitted just before `done` | Some clients may not expect a final delta after a long pause; the delta is append-only so accumulators stay correct | Tested with the existing streaming test cases; if a third-party client misbehaves, force non-stream mode for those callers |
| Failure to read a file is silent | If something is genuinely broken (file disappeared mid-flight), the user gets a partial response with no error | Acceptable trade-off — alternative is leaking the path. Add server-side telemetry counter if visibility is needed (`media_inline_dropped_total`) |

---

## 8. Risk assessment

| Risk | Likelihood | Impact | Notes |
|---|---|---|---|
| Existing channel adapters break | very low | high | Channel-adapter code was not touched and consumes `payloads.mediaUrls` independently; existing channel tests still pass |
| Test regression on `openresponses-http.test.ts` | low | medium | 15/16 tests pass; the one failure is environmental (unrelated to this code) |
| Performance regression on large reply payloads | low | medium | base64 of a 1 MB image adds ~1.4 MB to the response body and one `fs.readFile` on the gateway. Gateway already serves multi-MB SSE streams routinely |
| Data URI breaks browser markdown renderer | very low | low | `data:` URI is universally supported in `<img>` and `<a>` for the past decade |
| Agent's session log grows unboundedly | low | low | Already managed by existing session compaction |
| MEDIA: line stripping behavior changes for channel adapters | very low | high | We did not modify `splitMediaFromOutput` or `MEDIA_TOKEN_RE`. Agent text is still cleaned identically before reaching channel-adapter outputs |

---

## 9. Cross-references

- **Industry research summary** (used to pick Option α): see chat history of the design discussion. Key finding: ChatGPT/Claude both serve via signed URLs on dedicated user-content domains; no industry-standard `output_file` exists.
- **Codebase audit summary**: orphaned `src/media/host.ts` is reusable for Option β when video is in scope.
- **Related code**:
  - `src/media/parse.ts` (MEDIA token parser, untouched but central)
  - `src/auto-reply/types.ts:151-175` (canonical `ReplyPayload` shape with `mediaUrl` / `mediaUrls`)
  - `src/agents/tools/image-generate-tool.ts:673` (sample `MEDIA:<path>` emit site, untouched)
  - `src/media/store.ts` (where files actually live; persisted on bind-mounted volume `~/.openclaw/media/`)
  - `src/media/outbound-attachment.ts` (channel-adapter path, untouched)
- **Future iterations**:
  - Option β: revive `src/media/host.ts` (`ensureMediaHosted`) and re-host on gateway port 18789 instead of separate Express on 42873; swap `appendInlineMediaToText` body to mint URLs instead of base64.
  - Option γ: build `nabu-media` plugin + NestJS endpoint; same helper boundary, different upstream.

---

## 10. Commit checklist (when shipping this)

- [ ] `git diff` shows only `src/gateway/openresponses-media.ts` (new) and `src/gateway/openresponses-http.ts` (modified)
- [ ] No stray `.js` files in `src/` (compile artifacts from local testing should be cleaned up)
- [ ] `pnpm test src/gateway/openresponses-http.test.ts` passes 15/16 (the disconnect-test is the known environmental flake)
- [ ] Smoke-test in a running instance: `curl -X POST .../v1/responses` returns a `data:image/...` URI in `output_text` after generating an image
- [ ] Commit message references this doc: `feat(openresponses): inline tool-emitted media as data URIs in output_text`
