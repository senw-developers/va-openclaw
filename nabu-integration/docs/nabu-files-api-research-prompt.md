# Research Brief: NABU/OpenClaw Files API (NestJS + MinIO)

> **Two-stage brief.**
>
> 1. **Stage 1 — VA API (NestJS) team.** Read this end-to-end. Fill in the
>    "Stage 1 checklist" below, confirm or correct the assumptions called out
>    throughout the doc (look for **[ASSUMPTION]** markers), and add anything
>    NestJS-side the research agent must respect. Then forward the enriched
>    version to Stage 2.
> 2. **Stage 2 — research/design agent.** Read the enriched brief and produce
>    the design described in §10 ("Deliverables").
>
> **Output expected from Stage 2:** a self-contained design + implementation
> guide that a senior backend engineer can hand to a junior implementer.
>
> **Style for Stage 2:** opinionated, decisive. Pick one approach, justify
> trade-offs, do not dump a menu of "options" without a recommendation.

---

## Stage 1 checklist — for the VA API (NestJS) team

The research agent in Stage 2 will produce a design assuming our internal
stack behaves a certain way. Before forwarding, please fill in / confirm /
correct each item below. Reply inline next to each bullet (e.g.,
`**[VA API]** confirmed` or `**[VA API]** actually we use X — see <link>`).
If a section's answer is "no, and out of scope for this work", say that
explicitly.

### A. Stack confirmation

- **ORM:** TypeORM? Or have we moved any module to Drizzle/Prisma?
- **Database:** Postgres (single instance per env)?
- **Queue:** Bull on Redis? Shared Redis instance with cache, or dedicated?
- **Validation:** `class-validator` + `class-transformer`? Or have we
  standardized on zod anywhere?
- **OpenAPI:** Swagger module already wired across all controllers (the new
  module should follow that exact pattern)?

### B. Multi-tenancy & auth

- **Org-scope column name** on every table — `tenantOrganizationId`,
  `organizationId`, `orgId`? How is scoping enforced — interceptor, guard,
  service-layer parameter, Postgres RLS?
- **Existing JWT + MFA guards** the Files endpoints should reuse: which guard
  gates "fresh MFA", which handles standard authenticated access? Reference
  the exact decorator names.
- **RBAC** — do we already have an org-admin vs member abstraction the Files
  module should consume? Where is it defined?
- **OpenClaw → NestJS auth.** Today the `nabu-1password` /
  `nabu-google-workspace` plugins call back with `x-skill-token` +
  `x-organization-id`. Should OpenClaw use that exact pattern when uploading
  tool-generated files, or do you want a dedicated "service principal" flow?

### C. Existing infra to reuse

- **Audit log table.** Does one exist? Schema? If not, do we add one in scope
  of this work or out of scope?
- **Rate limiting.** Throttler module wired globally? Per-route overrides
  supported?
- **Quota tracking.** Any existing per-org usage counter we can extend, or is
  this green-field?
- **Event bus / domain events.** Do other modules emit `xxx.created` events
  we should mirror with `file.uploaded` / `file.deleted` / `file.expired`?
- **Soft-delete convention.** `deletedAt` timestamp, `state` enum, both, or
  hard-delete only?

### D. Identifiers & conventions

- **ID format** used across va-core-nest entities — UUIDv4? UUIDv7? ULID?
  Numeric? Should the public `file_…` ID be a separate human-prefixed ID
  alongside the DB primary key, or do we expose the primary key directly?
- **Pagination convention** — cursor-based (`before_id` / `after_id`) or
  offset-based (`page` / `limit`)? Which controller is the canonical mirror?
- **Error response envelope** — what shape do we return on 4xx / 5xx today?

### E. MinIO / storage

- **Bucket strategy in production** — confirm "one bucket per env"
  (`development`, `staging`, `production`).
- **CDN / edge in front of MinIO** in staging/prod (`cdn.staging.va.team`,
  prod equivalent). Are presigned URLs proxied through it, and does
  `MinioService.buildAssetUrl` already account for that round-trip?
- **Encryption at rest.** SSE-S3, SSE-KMS, or none?
- **Lifecycle rules** already applied at the bucket level — any we must
  align with or avoid colliding with?
- **Object size cap** in production today (MinIO config) — is there one?

### F. Existing modules we will touch

- Confirm **`apps/app/src/modules/assets`** is the only user-facing direct
  user of MinIO. (We saw `cms`, `users`, `auth`, `organizations` import
  `MinioService` — confirm whether they upload, or only read.)
- **VA API preference, surfaced now (Stage 2 will still justify the choice):**
  should the new Files module **subsume** the existing `assets` controller
  (deprecate `/v1/assets/*`) or run alongside?

### G. Frontend (so Stage 2 can write a credible §10.6)

- Stack — Next.js? Where does the chat UI currently render attachments
  (file paths)? Where does chat history replay live? Who owns the chat-UI
  repo, and is the same team consuming this brief?

### H. Anything else NestJS-side that must shape the design

Open space — add anything we haven't asked about that would change the
design: in-flight work, planned migrations, security-review constraints,
deployment limitations, regulatory constraints (PII / DSR), etc.

---

## 1. Mission

Design a dedicated **Files API** module inside our NestJS backend (`va-core-nest`) that
becomes the single canonical home for every binary the platform handles:

1. AI-generated artifacts (images, videos, audio, PDFs) produced by NABU/OpenClaw agents.
2. User-uploaded files (chat attachments, profile media, documents).
3. Files exchanged across channels (Slack/Discord/WhatsApp/Telegram/iMessage uploads
   and downloads).

The module must follow the conceptual shape of **Anthropic's Files API**
(`https://docs.anthropic.com/en/api/files`) and OpenAI's Files API as a secondary
reference: every binary becomes a server-issued **file ID**, references in
chat/agent payloads are by ID (or short-lived signed URL), and the binary itself
never leaks as a local container path or a base64 blob in transcripts.

The module replaces an in-tree workaround we already shipped (see §3.2)
that does not scale.

---

## 2. Why this exists

We previously shipped a tactical fix called **"Option α: inline media as
data-URI markdown"**
(see `nabu-integration/docs/openresponses-inline-media-delivery.md`).
It converts MEDIA paths emitted by tool plugins into base64 `data:` URIs
embedded in OpenResponses `output_text`.

That approach is failing in practice:

- **Hard 1 MB cap per file** before it gets dropped silently. Anything bigger
  (almost any video, most uncompressed images) is invisible to the user.
- **Transcript bloat.** Base64 in `output_text` inflates context, breaks prompt
  caching, and pollutes any client that stores raw transcripts.
- **No persistent URL.** The file lives only inside one HTTP response. Re-loading
  a chat session does not re-render the asset unless the frontend separately
  cached the data URI.
- **No multi-tenant audit/billing/retention story.** We cannot count usage,
  expire content, or revoke access per organization.
- **No upload path.** Inline-only is one-way (agent → user). User uploads still
  go through ad-hoc paths.

We need a real file substrate, not a workaround.

---

## 3. Current state (read this before designing anything)

### 3.1 Repository layout

- **`va-core-nest`** — NestJS monorepo. Multi-tenant (every resource is scoped
  to `organizationId` + `userId`). **[ASSUMPTION]** Uses Postgres + TypeORM,
  MinIO for blob storage, Bull/Redis for queues, JWT auth with MFA gating.
  *Stage 1 — VA API team: confirm or correct via §A and §B above.*
- **`va-openclaw`** — OpenClaw agent runtime (TypeScript/Node). Per-organization
  Docker Compose instance (`nabu-integration/instances/<orgId>/`). Talks to
  `va-core-nest` for org-scoped data. Exposes an OpenAI-compatible
  **OpenResponses** HTTP endpoint
  (`va-openclaw/src/gateway/openresponses-http.ts`) that the frontend chat UI
  consumes.

### 3.2 Files today: where binaries actually live

- **OpenClaw side:** tool plugins (Minimax image/video, browser screenshots,
  Google Workspace exports) write files to the gateway container's local disk
  at `~/.openclaw/media/<subdir>/<uuid>` and emit a `MEDIA:<path>` marker line.
  Code: `va-openclaw/src/media/store.ts` (writes), `va-openclaw/src/media/parse.ts`
  (`splitMediaFromOutput` strips MEDIA lines and produces `mediaUrls[]`).
- **Channel adapters** (Slack/Telegram/Discord/iMessage/MS Teams) read those
  paths and push bytes to their channel-native upload APIs. They never expose
  the local path to end users.
- **OpenResponses pipe** (the surface used by our web frontend) had no such
  adapter — it would echo the local container path verbatim. That is the leak
  Option α tried to plug.
- **Orphaned primitive:** `va-openclaw/src/media/host.ts` contains a built but
  unused HMAC-signed URL minter (`ensureMediaHosted`). It was scaffolded for an
  approach we never finished.

### 3.3 What is already wired in NestJS

> **[ASSUMPTION]** The bullets below are what we observed from a quick read
> of the repo. *Stage 1 — VA API team: confirm or correct each line.*

- **`@app/shared/minio`** (`va-core-nest/libs/shared/src/minio/`):
  fully functional `MinioService` with `uploadFile`, `uploadStream`, `streamFile`,
  `fetchFile`, `deleteFile`, `buildAssetUrl`, `ensureBucket`, `wipeBucket`,
  `getMinioObjectKey`, `getMinioDirKey`. Knows how to do dev-mode (`/api/v1/assets/proxy?...`)
  vs staging/prod (presigned URL) URL minting via `buildAssetUrl`.
- **`assets` module** (`va-core-nest/apps/app/src/modules/assets/`):
  thin proxy. Two endpoints: `GET /v1/assets/presigned` (mint a presigned URL
  by `objectName`) and `GET /v1/assets/proxy` (stream from MinIO through Nest).
  Has no concept of file ownership, file IDs, lifecycle, quotas, or upload.
  This is the *seed* the new Files API can grow from or replace — that is one
  of the key decisions you must make and justify (see §6).
- **Single bucket convention.** One bucket per environment, all objects share it.
  Prefixing/namespacing inside the bucket is by directory key.

### 3.4 What is NOT wired

- No `Files` domain entity in the database.
- No upload endpoint — clients today either bypass MinIO or hand-roll uploads
  through other modules.
- No org-scoped listing, deletion, or retention policy.
- No reference-by-ID in agent/chat payloads.
- No quota enforcement.
- No per-org access control on the proxy/presigned URL endpoints.

---

## 4. Reference design: Anthropic Files API

Match this surface conceptually. Adapt names where it makes sense for our
NestJS conventions (`/api/v1/files`, camelCase DTOs, etc.). Diverge only with
explicit justification.

| Anthropic operation | HTTP                                  | Notes                                               |
| ------------------- | ------------------------------------- | --------------------------------------------------- |
| Upload File         | `POST /v1/files` (multipart)          | Returns `{ id: "file_…", filename, size_bytes, mime_type, created_at, type, downloadable }` |
| List Files          | `GET /v1/files`                       | Pagination via `before_id` / `after_id` / `limit`.  |
| Get File Metadata   | `GET /v1/files/{file_id}`             | Metadata only, no bytes.                            |
| Download File       | `GET /v1/files/{file_id}/content`     | Streams bytes. Optional `content-disposition`.      |
| Delete File         | `DELETE /v1/files/{file_id}`          | Soft- or hard-delete (decide and justify).          |

OpenAI's Files API adds `purpose` (`assistants`, `fine-tune`, `vision`,
`user_data`, etc.). Decide whether we need a `purpose` discriminator or whether
a richer `tags`/`source` model fits us better.

The agent calling pattern we need to support:

- A tool produces a binary, the runtime POSTs it to `POST /v1/files` and gets a
  `file_id` back.
- The agent's text references the file by `file_id` (or a short-lived signed
  URL if the consumer cannot resolve IDs server-side).
- The frontend, on receiving an OpenResponses chunk, fetches metadata + signs a
  download URL via the Files API.
- On chat reload, the frontend re-resolves `file_id` → URL so historical media
  re-renders without storing bytes in the transcript.

---

## 5. Functional requirements

1. **Upload** — multipart `POST /v1/files`. Accepts:
   - File bytes (single file per request initially; multi-part chunked upload as
     a stretch goal).
   - Optional `purpose`/`tags` fields.
   - Optional `expires_in_seconds` override (else org default).
   - Optional `idempotency_key` (so retries don't duplicate).
2. **List / search** — paginated, filterable by `purpose`, `mime_type`, owner,
   created-at range, `tags`. Org-scoped. Sort by created-at desc by default.
3. **Metadata fetch** — `GET /v1/files/{id}`.
4. **Download** —
   - `GET /v1/files/{id}/content` streams bytes (auth-gated).
   - `GET /v1/files/{id}/url?ttl=…` mints a short-lived signed URL the
     frontend can hand directly to `<img>` / `<video>`. Use MinIO presigned
     URLs in staging/prod, the existing `/v1/assets/proxy` shape in dev.
5. **Delete** — soft-delete by default (preserve audit), hard-delete when the
   retention TTL elapses or via `DELETE …?hard=true`.
6. **Lifecycle / retention** —
   - Default org-level TTL (e.g., 90 days, configurable).
   - Per-file override via `expires_in_seconds` on upload.
   - Background sweeper (Bull worker) that hard-deletes expired soft-deleted
     rows AND purges the MinIO object.
7. **Quotas** — per-organization storage quota (bytes) and per-file size cap.
   Reject uploads with HTTP 413 / 429 + machine-readable error code when
   exceeded.
8. **Access control** —
   - Every file is keyed to `(organizationId, ownerUserId)`.
   - Org admins can list/delete any file in the org.
   - Members can only access their own files unless the file was shared via a
     resource link (chat session, organization-shared asset) — define how the
     ACL composes.
   - All endpoints require an authenticated principal except a narrow signed-URL
     download path.
9. **Auditing** — log every upload, download, delete with `(actor, file_id,
   org_id, ip, user_agent, action, ts)`. Reuse the audit log table
   `va-core-nest` already has for security-sensitive actions if it exists; if
   not, define one in scope.
10. **MIME / content sniffing** — never trust client-supplied `Content-Type`
    blindly. Sniff via magic bytes server-side. Persist both the declared and
    detected MIME. Reject MIME mismatches when policy says so (e.g., user
    avatar slot must be image/*).
11. **Antivirus / safe-content hook** (decision required) — should uploads pass
    through a scan step before becoming visible? Recommend yes-or-no with
    justification given our current threat model.

---

## 6. Key design decisions you must make and justify

For each: pick one, give the reasoning in 2-4 sentences, list trade-offs.

> **Note for Stage 2 (research agent):** Some of these may already be locked
> in by the Stage 1 checklist answers (especially #2 ID format, #4 bucket
> strategy, #7 schema column names, #8 OpenClaw → NestJS auth). Where Stage 1
> has answered, treat that answer as a constraint and design *around* it
> rather than re-litigating. Re-litigate only if the Stage 1 answer makes
> the design materially worse, and call that out explicitly.

1. **Replace `assets` module or evolve it?** The existing `assets` controller
   already speaks MinIO. Should the new Files module subsume it (and migrate
   `/v1/assets/*` to deprecation), or run side-by-side? If the latter, what is
   the contract between them?
2. **File ID format.** `file_<26-char-base32-ulid>`? `file_<uuidv7>`? Justify on
   sortability, leak resistance, and lookup ergonomics.
3. **Object key strategy in MinIO.** Recommend a layout. Anchor on
   `org/<orgId>/<purpose>/<yyyy>/<mm>/<file_id>/<safe_filename>` or argue for
   something better. Explain how it supports lifecycle policies, per-org bucket
   policies (if/when we shard), and migration.
4. **Bucket strategy.** One global bucket with prefixes (current shape) vs
   per-org bucket vs per-purpose bucket. Recommend one, factor in MinIO
   bucket-count limits, lifecycle rules, and multi-region replication.
5. **URL strategy.**
   - When to return a presigned URL vs a Nest-proxied URL vs the file ID alone.
   - TTL defaults and max.
   - How `buildAssetUrl`'s existing dev/prod split should evolve.
6. **Soft-delete vs hard-delete default.** Reconcile with retention TTL and
   audit logs.
7. **Schema.** Propose the TypeORM entity (column list, indexes, FKs). Include
   `tenantOrganizationId`, `ownerUserId`, `purpose`, `mimeType`,
   `detectedMimeType`, `sizeBytes`, `objectKey`, `bucket`, `etag`,
   `checksumSha256`, `state` (`active|soft_deleted|expired|quarantined`),
   `expiresAt`, `deletedAt`, timestamps, `metadata jsonb`. Argue every column
   you add or omit.
8. **OpenClaw → NestJS handoff.** OpenClaw runs in a separate container with
   only an internal network path to NestJS (`http://app:6001`). Decide:
   - How OpenClaw uploads (server-to-server token? per-org service token? mTLS?
     the same `x-skill-token` + `x-organization-id` pattern the
     `nabu-1password` / `nabu-google-workspace` plugins use today?)
   - Where the upload happens (a new OpenClaw plugin? the gateway directly?
     a thin wrapper around `src/media/store.ts`?)
   - Whether OpenClaw should keep its local-disk staging area at all or push
     straight through.
9. **OpenResponses integration.** Replace Option α end-to-end. Specify what
   the OpenResponses pipe emits — file IDs in `output_text`?
   `<media file_id="…" />` markup the frontend resolves? Annotations the way
   OpenAI's `image_generation_call` works? Pick one and justify.
   Reference: `va-openclaw/src/gateway/openresponses-http.ts`,
   `va-openclaw/src/gateway/openresponses-media.ts` (the inline-data-URI
   helpers we want to retire).
10. **Frontend contract.** What exactly does the chat UI need to do on receipt
    of a file reference, both in streaming and on history replay? Define the
    minimum frontend change.
11. **Channel adapter story.** Slack/Telegram/Discord adapters today consume
    local paths from `MEDIA:` markers. Do they migrate to file IDs? If so, do
    they download from the Files API before re-uploading to the channel, or
    do channels get a special "internal stream" route?
12. **Cross-environment URL signing.** MinIO in production sits behind
    `cdn.staging.va.team` / equivalent. Make sure presigned URLs round-trip
    correctly through any CDN/edge in front of MinIO.
13. **Backwards compatibility.** What happens to MEDIA: markers already in
    persisted chat history? Migration path?

---

## 7. Non-functional requirements

- **Performance.** Upload of a 25 MB file should not block the event loop;
  use `uploadStream` with backpressure. Download endpoint must stream, never
  buffer.
- **Reliability.** Idempotent uploads (same `idempotency_key` returns the
  original `file_id`). Atomic visibility — a file is never returned to clients
  before its MinIO object is fully committed.
- **Observability.** Structured logs + metrics
  (`files.upload.bytes`, `files.upload.duration_ms`, `files.download.bytes`,
  `files.delete.count`) tagged with `org_id` and `purpose`.
- **Security.**
  - URL signing keys live in env / secrets manager, rotatable without
    invalidating active sessions abruptly (key versioning).
  - Object keys must not leak PII (no raw filenames in keys, or at least a
    separate "display filename" column).
  - Rate-limit upload + signed-URL minting per org.
- **Deletion guarantees.** When a user is deleted or an org is offboarded,
  there must be a documented sweep that purges every related file from MinIO
  AND the metadata table.

---

## 8. Constraints

- **Stack:** NestJS, TypeORM, Postgres, Bull, MinIO. Do not introduce a new
  storage backend or queue system.
- **Auth:** must integrate with our existing JWT + MFA stack
  (`apps/app/src/modules/auth/*`). Do not invent a parallel auth scheme.
- **Multi-tenancy:** every query must be scoped by `tenantOrganizationId`.
  No "global" tables.
- **Network:** OpenClaw containers reach NestJS on the internal Docker network
  (`http://app:6001`) and may also be configured with raw IPs
  (`http://10.0.0.3:6001`). The Files API must work from both. No localhost
  assumptions, no "same-machine only" optimizations.
- **Existing primitives:** prefer reusing `MinioService` over new direct MinIO
  client code. If you need a new method, propose adding it to `MinioService`,
  not bypassing it.
- **No new packages** unless strictly necessary (and justify).

---

## 9. What you should research and bring back

1. **Anthropic Files API** — full surface, error model, edge cases (size caps,
   purpose semantics, expiration, beta-vs-GA differences). Cite the public
   doc.
2. **OpenAI Files API** — `purpose`, retention, integration with the Responses
   API, how `image_generation_call` and `container_file_citation` represent
   binary outputs in transcripts.
3. **MCP standard** — its dual model of inline base64 vs URL-by-reference for
   binary results. We want our design to be compatible with future MCP-style
   tool outputs.
4. **MinIO best practices** — bucket policies, lifecycle rules, presigned URL
   pitfalls, multipart upload, virtual-hosted vs path-style URLs through a
   CDN, server-side encryption modes (SSE-S3, SSE-KMS), bucket replication.
5. **OWASP / generic file-upload hardening** — magic-byte sniffing, polyglot
   files, SVG XSS, ZIP/TAR slip, archive bomb defenses, `Content-Disposition`
   handling, response-splitting risk in download endpoints.
6. **Comparable open-source designs** — how Mattermost, Rocket.Chat,
   Supabase Storage, or Nextcloud structure their file metadata + storage
   layer. Steal good ideas.

---

## 10. Deliverables (what the research output must contain)

Produce a single Markdown design doc with these sections, in this order:

1. **Executive summary** — 1 page, what we are building, the headline
   recommendations.
2. **Decisions** — every item from §6 answered with rationale.
3. **API specification** — every endpoint with request shape, response shape,
   error codes, sample curls. Include the OpenAPI fragment.
4. **Data model** — TypeORM entity (TS code) + migration sketch + the indexes
   you would add and why.
5. **Module layout** — NestJS file tree under
   `apps/app/src/modules/files/` with one-line description per file.
6. **Sequence diagrams** (in Mermaid) for the four critical flows:
   - User uploads a file from the web UI.
   - Agent (OpenClaw) generates a file and persists it.
   - Frontend renders a chat that contains a file reference (live + history
     replay).
   - Retention sweeper deletes expired files.
7. **OpenClaw integration plan** — concrete code-level changes needed in
   `va-openclaw` (file paths, function-level edits) to replace Option α and
   route MEDIA emissions through the Files API.
8. **Migration plan** — how existing chats with `data:` URI Option α blobs and
   the legacy `/v1/assets/*` endpoints are handled.
9. **Test plan** — unit, integration, and e2e tests we expect to add. Call
   out anything that needs a real MinIO container vs a mock.
10. **Risk register** — what can go wrong, what is the blast radius, what is
    the mitigation.
11. **Phased rollout plan** — what ships in Phase 1 (MVP), Phase 2 (parity),
    Phase 3 (polish: quotas, AV scan, multipart upload).
12. **Out-of-scope explicit list** — call out what you intentionally did NOT
    design for and why.

---

## 11. Code pointers (read these before writing the design)

> **Stage 1 — VA API team:** the `va-core-nest` list below is what we sampled
> from outside the repo. Please *extend* it (add missing files, replace any
> path that is wrong, link to internal-only docs the research agent should
> see). The `va-openclaw` list is authoritative — leave it as-is.

In `va-core-nest`:

- `apps/app/src/modules/assets/assets.controller.ts` — current proxy.
- `apps/app/src/modules/assets/assets.module.ts`
- `libs/shared/src/minio/minio.service.ts` — every primitive you need.
- `libs/shared/src/minio/minio.interface.ts` — DTOs.
- `apps/app/src/modules/auth/` — JWT + MFA guards we must reuse.
- `apps/app/src/modules/organizations/` — org scoping pattern (look at how
  existing modules scope queries; mirror that exactly).
- `apps/cli/src/modules/tests/commands/test-delete-minio-item.command.ts` —
  example of MinIO usage from a CLI seam.
- `apps/worker/src/worker.module.ts` — the worker container is where the
  retention sweeper job will live.

In `va-openclaw`:

- `nabu-integration/docs/openresponses-inline-media-delivery.md` — the workaround
  this design is replacing. Read it; the rollback section there enumerates
  every site that currently calls `appendInlineMediaToText`.
- `src/gateway/openresponses-http.ts` — OpenResponses HTTP entrypoint;
  4 call sites to retire.
- `src/gateway/openresponses-media.ts` — the inline-data-URI helpers; this
  whole file disappears once Files API is in place.
- `src/media/store.ts` — `saveMediaBuffer`, where tool plugins land bytes
  today.
- `src/media/parse.ts` — `MEDIA:` marker parser. Do we keep MEDIA markers as
  the in-process protocol and translate to file IDs at the gateway, or do we
  move plugins to emit file IDs directly? Decide and justify.
- `src/media/host.ts` — orphaned `ensureMediaHosted` (HMAC URL minter). Decide
  if it has any role left or should be deleted.
- `src/auto-reply/types.ts:151-175` — `ReplyPayload.mediaUrl` / `mediaUrls`
  shape that channel adapters consume. Determine whether this becomes
  `mediaFileIds: string[]` or stays as URLs once the Files API exists.
- `nabu-integration/spawn-seed/.openclaw/openclaw.json` — example of how org
  instances are configured. The Files API integration may need a new
  config block for `apiBaseUrl` + auth (mirror the `nabu-1password` /
  `nabu-google-workspace` plugin entries).

---

## 12. Hard non-goals

- **No new storage backend.** MinIO stays.
- **No GraphQL.** REST only, matching the rest of `va-core-nest`.
- **No per-file encryption-at-rest beyond what MinIO already provides** unless
  you make a strong case for it.
- **No client-side decryption.** Server-side only.
- **No "user types in a URL and we fetch on their behalf"** webhook/proxy
  features. Files come from authenticated uploads only.
- **No public/anonymous file links** in Phase 1. Every download is auth-gated
  or short-lived signed. We may revisit later.

---

## 13. Tone for the Stage 2 response

- Be opinionated. We are not looking for a survey, we are looking for one
  recommended design.
- Treat the Stage 1 checklist answers as ground truth. If an answer there
  contradicts something the brief states above, the Stage 1 answer wins.
- Quote the specific file paths and identifiers in the brief when you
  justify a decision.
- When you cite an external reference (Anthropic docs, OpenAI docs, MinIO
  docs), give the direct link.
- Where you must trade off, say what we lose, not just what we gain.
- Length budget: 30-60 pages of Markdown is fine if dense; do not pad.

---

## 14. Acceptance test for the design doc

The design is acceptable when:

1. A NestJS senior engineer can start implementing Phase 1 from §10.5 + §10.3
   without further questions.
2. A frontend engineer can wire chat rendering from §10.6 alone.
3. The OpenClaw integration plan §10.7 has concrete enough edits that we know
   which files change and which functions get touched.
4. Every decision in §6 has an answer + rationale; no "depends" or "TBD".
