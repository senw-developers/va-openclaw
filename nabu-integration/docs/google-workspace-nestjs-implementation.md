# Google Workspace (Drive + Calendar) — NestJS Implementation Brief

> **Who this is for.** A NestJS agent on `va-core-nest` building the server
> side of the Nabu Google Drive + Calendar integration.
>
> **Status.** OpenClaw side is fully implemented and merged on our fork
> (the `nabu-google-workspace` plugin + skill). This document is a
> contract-and-context spec — it tells you what to build, why, and what
> the gateway will send and expect back. It does not tell you how to
> shape your entities, encryption service, controllers, or single-flight
> code; you already have the `nabu-1password` integration as the
> immediate precedent on your side.

---

## 1. What this integration does

Each Nabu organization runs its own Dockerized OpenClaw instance. End users
inside that organization connect their **own** Google account (per-user)
via a Nabu dashboard page. NestJS stores the Google `refresh_token`
encrypted at rest, and pushes an **opaque per-org bearer** to the tenant's
OpenClaw instance over the existing WebSocket RPC (the same RMQ→gateway
path that already pushes SMTP and 1Password tokens). When the agent inside
that gateway needs to act on a specific user's Google data, the OpenClaw
plugin calls back to NestJS with the bearer + the requesting user's
identity. NestJS exchanges the encrypted `refresh_token` for a fresh
short-lived `access_token` against Google and returns it. The plugin
caches it briefly in process memory and uses it to call Google REST APIs
(Drive v3 + Calendar v3) on the user's behalf.

**Long-lived refresh tokens** exist only encrypted in the NestJS DB, plus
briefly in NestJS process memory during refresh. Never on the gateway.

**Short-lived access tokens** exist briefly in NestJS, optionally cached
in Redis with TTL ≤ Google's `expires_in`, and in the gateway plugin's
process memory keyed by `(organizationId, channel, userId)` for at most
~3500s with a 60-minute hard cap.

## 2. Why this shape

1. **Per-user OAuth, not domain-wide delegation.** Google's OAuth model
   is per-user. An organization with N members who want NABU to read/write
   Drive and Calendar needs N distinct connections. Domain-wide delegation
   is a Phase-2 enterprise opt-in for paid Workspace tenants only; the
   default is per-user with `(orgId, userId)` keying.

2. **Refresh tokens never leave NestJS.** They're the highest-value Google
   credential; centralizing decryption + refresh in NestJS keeps the blast
   radius small if a gateway is compromised, and Redis-locked single-flight
   on the NestJS side prevents the `invalid_grant` race two concurrent
   plugin calls would otherwise trigger.

3. **`openclaw.json` is prompt-extractable.** The agent can read its own
   config. So no raw refresh tokens go into config — only an opaque
   per-org `apiToken`. The required second factor (`organizationId`)
   lives in `process.env` (set by docker-compose), not in any file the
   agent can read.

This is the same pattern as `nabu-1password`, with two differences: the
upstream credential is a long-lived `refresh_token` rather than a
service-account token, and the access-token endpoint takes a per-user
identity in the body so NestJS can resolve the right connection row.

## 3. End-to-end flow

### 3.1 Connect flow (one-time per end user)

```
Dashboard UI ──► NestJS GET /api/v1/google-workspace/oauth/start
                  • HMAC-sign state := { orgId, userId, nonce, ts }
                  • return Google authorize URL

User consents on accounts.google.com
                  ──► Google redirects to:
                      GET /api/v1/google-workspace/oauth/callback?code&state
                  • verify HMAC state
                  • exchange code → { refresh_token, access_token, scopes, … }
                  • hit /oauth2/v3/userinfo for googleEmail
                  • AES-256-GCM encrypt refresh_token (salt 'nabu-google-v1')
                  • upsert user-connection row (orgId, userId, channel?)
                  • bump tokenVersion on parent config row
                  • generate / rotate opaque apiToken (32-byte hex)
                  • OpenClawRmqClient.setGoogleWorkspacePluginToken(orgId,
                    apiToken, tokenVersion) → RMQ → nabu-gateway
                                                  → config.patch into
                                                    plugins.entries.
                                                    nabu-google-workspace.config
                                                  → connection.rpc(
                                                    'nabu.googleworkspace.refresh', {})
```

### 3.2 Agent-uses-Google flow (every tool call)

```
OpenClaw gateway (per-org Docker)
  • Agent calls registered tool nabu_google({ method, path, query?, body? })
  • Plugin reads requesterSenderId + messageChannel from trusted ctx
  • Plugin validates resolved URL host + path allowlist
  • Plugin blocks DELETE on /drive/v3/files/<id> (forces soft-trash)
  • Plugin checks (orgId, channel, userId) cache; on miss/stale:
        POST /api/v1/google-workspace/access-token
        headers: x-skill-token, x-organization-id
        body:    { userId, channel }
        timeout: 10s

NestJS
  • look up config by (sha256(apiToken), orgId)         → 401 on mismatch
  • look up user-connection by (configId, userId)        → 404 on missing
  • if needsReconsent flag set                          → 410
  • Redis single-flight lock keyed (orgId, channel, userId)
  • decrypt refresh_token; POST oauth2.googleapis.com/token (grant=refresh)
  • on Google invalid_grant → mark needsReconsent, throw 410
  • cache (accessToken, expiresAt) in Redis (TTL ≤ expires_in)
  • return { accessToken, expiresAt, scopes, tokenType: "Bearer" }

OpenClaw gateway
  • sanity-clamp expiresAt; cache if reasonable; use access_token
  • call https://www.googleapis.com/{drive|calendar}…
    Authorization: Bearer <accessToken>; 30s timeout
  • on Google 401 → invalidate cache, refetch token, retry once
  • branch on Content-Type: text/JSON inline; binary → base64
  • hoist error.errors[0].reason and Retry-After to result envelope
```

## 4. The contract NestJS must honor

This is the load-bearing section. The OpenClaw plugin is built against
exactly this shape; everything else is your call.

### 4.1 Internal: `POST /api/v1/google-workspace/access-token`

Called only from per-org OpenClaw containers via Docker bridge. Must not
be reachable from the public internet.

**Headers** (both required, both validated against the same DB row):

| Header              | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `x-skill-token`     | Per-org opaque bearer (32-byte hex). Rotated on connect / disconnect. |
| `x-organization-id` | Numeric org id from the gateway's docker-compose env.                 |

If either is missing or the pair doesn't match a stored config row → 401.

**Request body:**

```json
{
  "userId": "<gateway requesterSenderId — channel-scoped sender id>",
  "channel": "<gateway messageChannel — telegram / slack / web / whatsapp / …>"
}
```

- `userId` is the trusted sender id from the agent's tool context. The
  same value the user sent during the OAuth connect flow (you stored it
  on the connection row).
- `channel` is the trusted gateway-side channel id. **Always sent by the
  plugin.** Today you can store `channel` informationally and look up by
  `(configId, userId)`; once a second channel ships, switch the unique
  key to `(configId, channel, userId)`. The plugin's cache is already
  partitioned per channel so the same userId in different channels gets
  separate tokens.
- **`scopes` is intentionally NOT in the request body.** An earlier draft
  forwarded LLM-supplied scopes; that opens a prompt-injection
  scope-escalation vector. Treat the granted scope set as whatever the
  user actually consented to at connect time. Your refresh exchange must
  not request broader scopes than were originally granted.

**Response 200:**

```json
{
  "accessToken": "ya29.A0…",
  "expiresAt": 1735689600,
  "scopes": ["openid", "email", "profile",
             "https://www.googleapis.com/auth/drive.file",
             "https://www.googleapis.com/auth/calendar.events",
             "https://www.googleapis.com/auth/calendar.freebusy"],
  "tokenType": "Bearer"
}
```

- `expiresAt` is **Unix seconds**, absolute. The plugin uses
  `expiresAt - 120s` as its refresh-ahead window (sized for ±10s
  container clock drift) and additionally caps any cached token at
  60 minutes regardless of upstream-claimed expiry. The plugin **rejects
  implausible values** (>2h in the future is treated as a backend bug —
  used once, not cached). Don't return `Date.now()` in milliseconds, and
  don't return non-finite values.
- `tokenType` is forwarded as-is. Always return `"Bearer"`.
- `scopes` is informational — the plugin records and exposes it but does
  not gate calls on it. Return what Google returned on the refresh.
- The plugin does **not** validate any specific token prefix (e.g. `ya29.`).
  Don't strip it, don't synthesize it.

**Error responses:**

| Status | Body                                                                              | When                                                                                     |
| ------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 401    | `{ "error": "Invalid skill credentials" }`                                        | Missing or mismatched `x-skill-token` / `x-organization-id`.                             |
| 404    | `{ "error": "Google connection not found for this user. Connect at /settings/integrations/google." }` | No connection row for `(configId, userId)`.                                              |
| 410    | `{ "error": "Re-consent required", "reason": "invalid_grant" }`                   | `needsReconsent` flag set, OR Google returned `invalid_grant` on this refresh exchange.  |
| 502    | `{ "error": "Google refresh failed", "detail": "<sanitized>" }`                   | Any other Google token-endpoint failure. Sanitize: never echo refresh tokens or codes.   |

Don't put the raw `refresh_token` in any error response. Don't echo back
the request `x-skill-token`.

### 4.2 What the endpoint will actually see in production

| Scenario                                                | Plugin behavior                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| First call after `gateway_start`                        | One POST.                                                                                                          |
| Cached and fresh                                        | No call.                                                                                                           |
| Cached but stale (`expiresAt - 120s` past)              | One POST.                                                                                                          |
| `tokenVersion` bump in `openclaw.json`                  | Cache invalidated → next call is a POST.                                                                           |
| `nabu.googleworkspace.refresh` RPC fired by NestJS      | Plugin clears its cache → next call is a POST.                                                                     |
| Concurrent agent tool calls for the same user           | The plugin does **not** dedupe in-process today. You may see N concurrent POSTs from one gateway for one user. **Your Redis single-flight lock must coalesce them**, otherwise concurrent calls each refresh against Google and the second trips `invalid_grant`. |
| Google API returns 401 on a tool call                   | Plugin invalidates its cache and POSTs once more for that user. **Endpoint may see two POSTs ~100ms apart.** Same Redis lock handles this.                                              |
| Poisoned `apiBaseUrl`                                   | Plugin only calls back to URLs matching `^http://app:\d+$` or `^http://nabu-[a-z0-9-]+-app:\d+$`. Other URLs pushed via `config.patch` are ignored. The plugin will not be redirected to an attacker-controlled NestJS impersonator. |
| Plugin can't reach NestJS                               | After a 10-second timeout, the plugin returns an error envelope to the agent. No retries.                          |

### 4.3 Public OAuth + dashboard endpoints

| Method | Path                                                  | Auth                  | Body / Query                  | Returns                                         |
| ------ | ----------------------------------------------------- | --------------------- | ----------------------------- | ----------------------------------------------- |
| GET    | `/api/v1/google-workspace/oauth/start`                | JWT                   | —                             | `{ authorizeUrl }` to redirect to.              |
| GET    | `/api/v1/google-workspace/oauth/callback`             | Public (state-signed) | `?code&state` or `?error`     | 302 to dashboard success/error page.            |
| GET    | `/api/v1/google-workspace/connections`                | JWT                   | —                             | List of per-user connections (metadata only).   |
| POST   | `/api/v1/google-workspace/connections/:userId/test`   | JWT                   | —                             | Health probe result (refresh + userinfo).       |
| DELETE | `/api/v1/google-workspace/connections/:userId`        | JWT                   | —                             | 204; revokes upstream + drops the row.          |
| DELETE | `/api/v1/google-workspace/config`                     | JWT, org-admin        | —                             | 204; revokes all users + disables plugin.       |

The OAuth callback is the only public route. Protect it via a HMAC-signed
`state` parameter (sign over `{ orgId, userId, nonce, ts }`, verify with
constant-time compare, expire after ~600s).

### 4.4 What you must push to the gateway

After connect / rotate / disconnect, push to OpenClaw via the existing
RMQ → nabu-gateway → `config.patch` pipe (same path SMTP and 1Password
already use). Suggested RMQ method name: `google-workspace-plugin.set-token`,
payload `{ apiToken, tokenVersion }` routed on `organizationId`.

Land the patch under:

```jsonc
{
  "plugins": {
    "entries": {
      "nabu-google-workspace": {
        "enabled": <apiToken !== "">,
        "config": {
          "apiToken": "<32-byte hex or empty to disable>",
          "apiBaseUrl": "http://app:6001",
          "tokenVersion": <monotonic counter>
        }
      }
    }
  }
}
```

After the patch lands, fire `connection.rpc('nabu.googleworkspace.refresh', {})`
to immediately invalidate the plugin's in-memory cache. The plugin's
periodic re-validation cadence is 6h, but the RPC cuts rotation latency
to seconds.

`apiBaseUrl` is constrained on the plugin side to a docker-internal
allowlist; pushing anything else is a no-op. `tokenVersion` is a monotonic
integer — bump it on every connect / disconnect / rotate / re-consent.
The plugin uses `tokenVersion` to invalidate its cache without waiting
for an RPC.

## 5. What NestJS owns

Implement these on your side. Mirror your `nabu-1password` precedent for
file shape, transaction patterns, and DTO conventions.

- **Entities.** Two-table model:
  - `OrganizationGoogleWorkspaceConfigEntity` — one row per org. Holds
    `apiKeyHash`, `tokenVersion`, status. FK → `OrganizationEntity`.
  - `OrganizationGoogleWorkspaceUserConnectionEntity` — one row per
    `(orgId, userId)`. Holds the AES-256-GCM-encrypted `refresh_token`,
    `googleEmail`, `grantedScopes` (array), `tokenFingerprint` (12 hex of
    sha256), `lastValidatedAt`, `lastValidationError`, `needsReconsent`.
    FK → config (cascade delete).
  - When you ship a second channel, extend the unique index on the
    connection table to `(configId, channel, userId)`. Until then,
    `(configId, userId)` is fine; the plugin sends `channel` regardless.
- **Encryption.** Same AES-256-GCM scrypt-derived-key pattern as
  `OnePasswordEncryptionService`. **Salt: `'nabu-google-v1'` — must
  differ from `'nabu-op-v1'` and `'va-team-smtp-enc-v1'`** so a key leak
  in one integration cannot decrypt another's ciphertext.
- **OAuth flow.**
  - Web-server flow with `access_type=offline`, `prompt=consent`,
    `include_granted_scopes=true`, PKCE.
  - HMAC-sign the `state` parameter (constant-time verify, ~600s TTL).
  - Token exchange: `https://oauth2.googleapis.com/token`.
  - Userinfo (for the email displayed on the connection row):
    `https://openidconnect.googleapis.com/v1/userinfo`.
  - Revocation on disconnect: `https://oauth2.googleapis.com/revoke`.
  - **Native `fetch` is sufficient** — these are tiny URL-form POSTs.
    Don't add `googleapis` to `package.json`; all Drive/Calendar API
    calls happen on the OpenClaw side, not yours.
- **Single-flight refresh.** Redis lock keyed `(orgId, channel, userId)`.
  TTL ~30s. On contention, poll the cache key briefly, then fall through
  if the lock-holder crashed.
- **Phase 1 scopes** (CASA-exempt): `openid email profile` +
  `https://www.googleapis.com/auth/drive.file` +
  `https://www.googleapis.com/auth/calendar.events` +
  `https://www.googleapis.com/auth/calendar.freebusy`.
  Phase 2 (later, behind CASA Tier 2): `drive.readonly`. Use
  `include_granted_scopes=true` for the Phase-2 upgrade so users don't
  re-consent for Phase-1 scopes.
- **RMQ client extension.** Add one method
  (`setGoogleWorkspacePluginToken(orgId, apiToken, tokenVersion)`)
  alongside the existing 1Password method. Same `Exchanges.NabuRpc`,
  routing on `organizationId`. Called on every connect / disconnect /
  rotate.
- **Required env vars.** `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (must match
  Google Cloud Console exactly), `DASHBOARD_BASE_URL` (where to redirect
  after the OAuth callback). The user has already provisioned a working
  GCP project + Client ID for local dev:
  `655544024452-h994pj242cn3hftnsgcobg1qqh7p8uns.apps.googleusercontent.com`
  with redirect `http://localhost:6001/api/v1/google-workspace/oauth/callback`.
  Production redirect URI must be registered under the same Client ID
  before staging rollout.
- **Log scrubber.** Add to your existing redaction pipeline:
  - `/ya29\.[A-Za-z0-9_\-]{20,}/g` → `[REDACTED_GOOGLE_ACCESS_TOKEN]`
  - `/1\/\/0[A-Za-z0-9_\-]{20,}/g` → `[REDACTED_GOOGLE_REFRESH_TOKEN]`
  - Both prefixes are documented Google sentinels — safe to scan for.
- **Audit events** (if you have an audit log). Emit on connect /
  disconnect / re-consent / scope-upgrade / refresh-failed /
  webhook-revoked / quota-exhausted, scoped to `(orgId, userId)`.

## 6. Invariants the plugin assumes you'll honor

These aren't suggestions — the plugin is hard-coded around them:

1. **The two-factor model is binding.** `x-skill-token` alone is
   insufficient; `x-organization-id` must come in on every callback and
   match the same DB row. Don't add a "trusted IP" mode that skips one
   factor. (We've shipped this exact model for 1Password and SMTP; this
   is the third repetition.)
2. **`scopes` in the request body is rejected, not honored.** If you
   accept a `scopes` field for forward-compatibility, it must NOT
   influence the refresh exchange or the granted scope set.
3. **`expiresAt` is Unix seconds.** Not milliseconds. Not `Date.now()`.
   Not negative. Not `Infinity`. The plugin sanity-clamps and warns on
   anomalous values.
4. **`tokenType: "Bearer"`.** No other value supported by the plugin's
   downstream HTTP code.
5. **Refresh tokens never appear in any HTTP response, log line, or
   error body.** Apply the log scrubber regex everywhere and verify it
   in tests.
6. **`tokenVersion` is monotonic and bumped on every state-changing op.**
   The plugin uses the value verbatim for cache invalidation; non-monotonic
   bumps cause stuck caches.
7. **Disconnect is destructive but reversible.** Disconnect = revoke at
   Google + delete the row + `setGoogleWorkspacePluginToken(orgId, "",
   newTokenVersion)` to disable the plugin. Reconnect = fresh OAuth flow,
   not a "resume".

## 7. Acceptance — what to verify end-to-end

1. **Migrations apply.** Both tables exist; FK + unique constraints in place.
2. **Encryption round-trips.** Salt `'nabu-google-v1'`. `decrypt(encrypt(x)) === x`.
   Distinct ciphertext per call (random IV).
3. **State HMAC.** Round-trips correctly; tampered payloads rejected;
   expired (>600s) state rejected.
4. **OAuth callback happy path.** Mocked Google token endpoint feeds a
   valid `code`; assert encrypted refresh on the row, googleEmail
   populated from `/userinfo`, `tokenVersion` bumped, RMQ push called
   with new `apiKey` + `tokenVersion`.
5. **Two-factor access-token callback.**
   - Matching credentials + body → 200 with the documented response shape.
   - Mismatched org id → 401.
   - Missing headers → 401.
   - Valid auth but `userId` not connected → 404.
   - Connection marked `needsReconsent: true` → 410.
6. **Single-flight refresh.** 10 simultaneous calls for the same
   `(orgId, channel, userId)` result in exactly one Google token-endpoint
   exchange.
7. **Config patch lands on gateway.** After OAuth callback, the tenant's
   `openclaw.json` shows `enabled: true`, non-empty `apiToken`, and
   `tokenVersion ≥ 1` under `plugins.entries["nabu-google-workspace"]`.
8. **Plugin probes backend.** Gateway logs show
   `[nabu-google-workspace] configured (apiBaseUrl=…, tokenVersion=…)`
   and **no occurrence of `ya29.` or `1//0`** anywhere.
9. **Agent round-trip.** Send a message: _"Use the nabu-google-workspace
   skill to list my next 5 calendar events."_ The agent calls
   `nabu_google({ method: "GET", path: "/calendar/v3/calendars/primary/events", … })`
   and returns the events.
10. **Re-consent.** Manually flip `needsReconsent=true`. Next agent call
    surfaces the re-consent error. Reconnecting via `oauth/start` clears
    the flag.
11. **Disconnect.** Single-user disconnect: Google revoke called, row
    deleted, Redis cache cleared, `tokenVersion` bumped. Org-wide
    disconnect: gateway sees `enabled: false`, all caches gone.

## 8. What's already done on the OpenClaw side

You don't need to change any of this. Listed so you know the contract you're
building against.

### 8.1 Plugin

[extensions/nabu-google-workspace/](../../extensions/nabu-google-workspace/):

| File | Role |
| --- | --- |
| [openclaw.plugin.json](../../extensions/nabu-google-workspace/openclaw.plugin.json) | Manifest. Config schema: `apiToken`, `apiBaseUrl`, `tokenVersion`, `refreshIntervalMs`. `enabledByDefault: false`. |
| [package.json](../../extensions/nabu-google-workspace/package.json) | `@va-team/nabu-google-workspace`. Zero runtime deps. |
| [api.ts](../../extensions/nabu-google-workspace/api.ts) | Local barrel — re-exports from `openclaw/plugin-sdk/plugin-entry`. |
| [index.ts](../../extensions/nabu-google-workspace/index.ts) | Plugin entry. Registers `nabu_google` tool, `gateway_start` / `gateway_stop` hooks, periodic re-validation (6h), and the `nabu.googleworkspace.refresh` RPC handler that drops the in-memory cache. |
| [src/nabu-google-workspace.constants.ts](../../extensions/nabu-google-workspace/src/nabu-google-workspace.constants.ts) | Endpoints, timeouts, allowlists for path prefix and `apiBaseUrl`. |
| [src/nabu-google-workspace.interface.ts](../../extensions/nabu-google-workspace/src/nabu-google-workspace.interface.ts) | Config shape, request/response shapes, in-memory cache shape. |
| [src/config.ts](../../extensions/nabu-google-workspace/src/config.ts) | Live config reader (`api.runtime.config.loadConfig()`), `apiBaseUrl` allowlist enforcement. |
| [src/token.ts](../../extensions/nabu-google-workspace/src/token.ts) | Per-`(orgId, channel, userId)` access-token cache, NestJS callback, sanity-clamp on `expiresAt`, fingerprint helper, defensive logging. |
| [src/tools/nabu-google.tool.ts](../../extensions/nabu-google-workspace/src/tools/nabu-google.tool.ts) | The single `nabu_google` agent tool. Path-allowlist post-resolution, hard-delete block, retry-once on Google 401, Content-Type branching, error-reason hoisting, `Retry-After` surfacing. |
| [skills/nabu-google-workspace/SKILL.md](../../extensions/nabu-google-workspace/skills/nabu-google-workspace/SKILL.md) | The runbook the agent reads to build correct Drive/Calendar calls. |

### 8.2 Tool surface exposed to the agent

One tool: `nabu_google`. Single passthrough — the agent supplies `method`,
`path` (allowlisted prefix), optional `query`, optional `body`. Auth is
injected by the plugin; the agent never sees a token. Result envelope
contains `{ status, ok, url, method, response, error?, errorReason?,
retryAfterSeconds?, encoding?: "base64" }`.

This shape is deliberate: a single thin tool plus a detailed
`SKILL.md` runbook beats nine hand-coded per-endpoint tools, and gives
us markdown-only extensibility for new Google APIs without recompiling
the plugin.

### 8.3 Security hardening (responses to validator findings)

The plugin was reviewed by three validation agents (OpenClaw consistency,
industry best-practice, security). Every finding worth shipping was
addressed:

| Finding | Mitigation |
| --- | --- |
| **CRITICAL** — path-traversal bypass via raw-string `startsWith` allowlist (`/drive/v3/../../gmail/v1/...`) | Validate the **resolved** `URL.host` and `URL.pathname` after `new URL(path, base)`. |
| **HIGH** — `apiBaseUrl` attacker-redirectable from a poisoned `config.patch` | Regex allowlist for docker-internal hostnames; any other URL is ignored. |
| **HIGH** — no fetch / `node:http` request timeouts (gateway can hang forever) | 10s timeout on the NestJS callback; 30s `AbortSignal.timeout` on Google calls. |
| **MEDIUM** — `senderId` collision across channels could leak tokens cross-user | Cache key + NestJS request body include `channel` from the trusted gateway context. |
| **MEDIUM** — LLM-supplied `scopes` enables prompt-injected scope escalation | `scopes` removed from the agent-facing schema and the access-token request body. |
| **BLOCKER** — `ya29.` prefix check rejects valid tokens (Google doesn't guarantee prefix) | Validate non-empty string + finite `expiresAt` only. |
| **important** — local `stringEnum` / `jsonResult` shadow shared SDK helpers | Both imported from `openclaw/plugin-sdk/channel-actions`. |
| **important** — `expiresAt` blindly trusted | Sanity-clamp: reject >2h-future or <120s-remaining; 60-min hard cache cap regardless. |
| **important** — binary downloads (`alt=media`, `image/png`) UTF-8-corrupted | Branch on Content-Type; binary returned as base64 with `encoding: "base64"`. |
| **important** — Google `error.errors[0].reason` and `Retry-After` not surfaced | Both hoisted to the result envelope so the LLM can branch reliably. |
| **important** — no retry on transient Google 401 | Invalidate cache, refetch token, retry once before surfacing the error. |
| **important** — numeric query values rejected by schema | Schema accepts `string \| number \| boolean`; tool stringifies before serializing. |
| **LOW** — prompt-injectable hard-delete on Drive | `DELETE /drive/v3/files/<id>` blocked at the plugin layer; agent steered to soft-trash via `PATCH … {trashed: true}`. SKILL.md updated. |
| **LOW** — `apiToken` could echo back in NestJS error body | `redactApiToken()` strips it before logging or surfacing. |
| **LOW** — empty-string `apiBaseUrl` falls through nullish-coalesce | Truthy fallback via the same allowlist validator. |

### 8.4 Spawn-seed + instance configuration

- [nabu-integration/spawn-seed/.openclaw/openclaw.json](../spawn-seed/.openclaw/openclaw.json):
  - `nabu-google-workspace` added to `plugins.allow`.
  - Default `plugins.entries."nabu-google-workspace"` entry with
    `enabled: false`, empty `apiToken`, `tokenVersion: 0`, default
    `apiBaseUrl: "http://app:6001"`. Your `config.patch` flips it on.
  - `skills.entries.gog.enabled: false` to avoid collision with the new
    `nabu-google-workspace` SKILL.md (the bundled `gog` skill describes
    a different per-host filesystem auth model that contradicts ours).
- [nabu-integration/instances/nabu-1/.openclaw/openclaw.json](../instances/nabu-1/.openclaw/) — same updates for local testing.

### 8.5 Local validation already performed

The user has already exercised the Google OAuth dance end-to-end against
a working GCP project from the dashboard side and confirmed the redirect
hits NestJS with a valid `code`. The 404 they saw is expected because
NestJS hasn't implemented the callback yet — that's the trigger for this
spec.

## 9. References

**Google APIs:**

- [OAuth 2.0 web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server) — authorize URL, code exchange, `access_type=offline`, `prompt=consent`.
- [Incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth) — `include_granted_scopes=true` for Phase-2 scope upgrades.
- [Token endpoint](https://developers.google.com/identity/protocols/oauth2/web-server#exchange-authorization-code) — `https://oauth2.googleapis.com/token`.
- [Refresh tokens](https://developers.google.com/identity/protocols/oauth2/web-server#offline) — `invalid_grant` semantics.
- [Token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke) — `https://oauth2.googleapis.com/revoke`.
- [OpenID Connect userinfo](https://developers.google.com/identity/openid-connect/openid-connect#obtainuserinfo) — `https://openidconnect.googleapis.com/v1/userinfo`.
- [Drive `drive.file` scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) — non-sensitive, CASA-exempt.
- [Calendar API v3 auth](https://developers.google.com/calendar/api/auth) — sensitive scopes (`calendar.events`, `calendar.freebusy`) require brand+scope review only.
- [App verification (sensitive scopes)](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) — 3–5 business days.
- [App verification (restricted scopes)](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) — Phase 2; CASA Tier 2 required.

**OpenClaw (our fork):**

- [Plugin SDK entry](../../src/plugin-sdk/plugin-entry.ts).
- [`nabu-1password` integration](../../extensions/nabu-1password/) — direct precedent on the OpenClaw side.
- [`1password-nestjs-implementation.md`](./1password-nestjs-implementation.md) — direct precedent on your side, including the encryption-service shape, two-factor callback pattern, RMQ client extension, and log scrubber wiring.
- [`config.patch` deep-merge handler](../../src/gateway/server-methods/config.ts) — the same RPC the 1Password integration already uses.
