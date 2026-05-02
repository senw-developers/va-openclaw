# Google Workspace integration — NestJS handoff: passing the user identity on agent dispatch

> **Who this is for.** A NestJS engineer wiring up the dashboard chat
> path so the gateway-side `nabu-google-workspace` plugin can act on
> behalf of a specific end user.
>
> **TL;DR.** The OpenClaw side already has Drive + Calendar working.
> The plugin needs to know **which dashboard user is currently
> chatting** so it can ask NestJS for that user's Google access token.
> The OAuth connect flow already stores per-user connection rows; you
> just need to pass the same `userId` string in the OpenAI-standard
> `user` field on every `/v1/responses` request you send to the
> gateway.

---

## 1. The problem this solves

The `nabu-google-workspace` plugin is loaded and the `nabu_google` tool
is registered, but every tool call currently fails with:

```
"No requester identity in tool context — Google calls require a per-user OAuth grant."
```

This is the plugin's own early-exit guard. It needs the agent's
`requesterSenderId` to know which `(organizationId, userId)` to ask for
when calling the access-token endpoint:

```
POST /api/v1/google-workspace/access-token
{ "userId": "<senderId>", "channel": "<messageChannel>" }
```

The dashboard's chat path dispatches via the gateway's OpenAI-compatible
HTTP API (`POST /v1/responses`). That API does not currently propagate
any user identity into the agent runtime. We're adding a small
OpenClaw-side change to thread the OpenAI-standard `user` field through
to the agent's tool context.

After this change ships, NestJS just needs to **include `user` on every
`/v1/responses` call**, and Drive/Calendar tool calls will resolve
against the matching Google connection row.

## 2. What's changing on the OpenClaw side (already planned)

We're adding ~20 lines of OpenClaw core code:

- **`src/agents/command/types.ts`** — add `senderId?: string` to
  `AgentCommandOpts` (and inherited `AgentCommandIngressOpts`).
- **`src/agents/agent-command.ts`** — thread `opts.senderId` into the
  embedded runner's `senderId` param so it lands in
  `OpenClawPluginToolContext.requesterSenderId`.
- **`src/gateway/openresponses-http.ts`** — at the call site that
  bridges `/v1/responses` → `agentCommandFromIngress`, pass
  `senderId: payload.user?.trim() || undefined`.

No NestJS-side OpenClaw library upgrades required (the gateway is the
HTTP boundary). NestJS only needs to start sending the `user` field.

## 3. What NestJS needs to do

### 3.1 Pass `user` on every `/v1/responses` request

OpenAI's Responses API includes a top-level optional `user` string,
documented as *"A unique identifier representing your end-user, which
can help to monitor and detect abuse."* Use it.

```http
POST /v1/responses
Host: <gateway-host>:<gateway-port>
Content-Type: application/json
Authorization: Bearer <gateway-token>

{
  "model": "cloudflare-ai-gateway/claude-sonnet-4-5",
  "input": [
    {
      "role": "user",
      "content": "Create a Google Doc called Hello from Nabu"
    }
  ],
  "user": "<dashboard-user-id>",
  "stream": false
}
```

If you use the `openai` SDK or any compatible client, this is just the
`user` constructor option. No custom headers required.

### 3.2 What to send in `user`

Send **the exact same string** you stored on the
`OrganizationGoogleWorkspaceUserConnectionEntity.userId` column at
OAuth-connect time. The plugin will pass it back to you verbatim on the
access-token callback as `{ userId, channel }`, and you'll join it to
the connection row.

**Recommended choice: the NABU users-table primary key as a string**
(numeric id stringified or UUID). Reasons:

- Stable for the lifetime of the user account.
- Already in your JWT; trivially available wherever the dashboard
  dispatches a chat message.
- Not coupled to the user's Google email (which can change), and
  doesn't preclude multi-Google-account-per-NABU-user later.
- Opaque to OpenClaw — the string is never parsed there.

**Avoid:**

- Email addresses (mutable).
- The Google account email (binds to the wrong identity).
- Anything per-session or per-request (must be stable).

Length: keep ≤ 64 chars to stay within OpenAI's documented practical
limit.

### 3.3 Wire format — recap

The full round-trip looks like this:

```
Dashboard user types in chat
   │
   ▼
NestJS POST /v1/responses
   { user: "42", input: [...], model: "..." }
   │
   ▼
Gateway runs the agent. Tool context's requesterSenderId = "42".
   │
   ▼
Agent invokes nabu_google({ method, path, body, ... })
   │
   ▼
Plugin POSTs back to NestJS:
   POST /api/v1/google-workspace/access-token
     headers: x-skill-token, x-organization-id
     body: { "userId": "42", "channel": "webchat" }
   │
   ▼
NestJS finds the connection row keyed by (configId, userId="42"),
decrypts the refresh token, exchanges with Google, returns access_token.
   │
   ▼
Plugin calls Google API with the access_token.
   │
   ▼
File appears in user 42's Drive. Done.
```

### 3.4 Make it consistent across surfaces

Anywhere NestJS dispatches an agent message on behalf of an
authenticated user — dashboard chat box, follow-up notifications,
scheduled tasks running on a user's behalf — pass the same `user`
value. If a system task with no real human owner triggers an agent run,
either:

- skip Google-touching tools (the plugin will surface the
  "No requester identity" error gracefully), or
- pick a deterministic system identity (e.g. `"system:cron"`) and
  store a connection row for it.

## 4. Acceptance — how to verify it works end-to-end

After the OpenClaw-side change ships and NestJS passes `user`:

1. **Have a connected user.** Dashboard user `42` completes the OAuth
   flow; `OrganizationGoogleWorkspaceUserConnectionEntity` now has a
   row for `(configId, userId="42")` with the encrypted refresh token.

2. **Send a probe request.** Either via the dashboard, or directly with
   curl:

   ```bash
   curl -sS -X POST http://<gateway-host>:18789/v1/responses \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <gateway-token>" \
     -d '{
       "model": "cloudflare-ai-gateway/claude-sonnet-4-5",
       "input": [{"role":"user","content":"What are my next 5 calendar events?"}],
       "user": "42",
       "stream": false
     }'
   ```

3. **Expected outcome.** The agent's response lists actual Calendar
   events. Gateway logs show:

   ```
   [nabu-google-workspace] access token fetched (fingerprint=…, expires_in=…s, scopes=…, latency_ms=…)
   [nabu-google-workspace] GET /calendar/v3/calendars/primary/events → 200 (latency_ms=…)
   ```

4. **Negative test.** Send the same request **without** `user` (omit
   the field). Expect the plugin's "No requester identity" error,
   confirming the gating still works for unauthenticated callers.

5. **Round-trip test.** *"Create a Google Doc called Hello from Nabu
   with a one-line summary."* The doc should appear in user 42's Drive
   under "My Drive" (NABU-owned, since it was created via
   `drive.files.create`).

## 5. Things that are already done (FYI)

You don't need to change any of this — listed only so you have the
full context.

- **Plugin shipped:** [extensions/nabu-google-workspace/](../../extensions/nabu-google-workspace/)
  is loaded and registers the `nabu_google` tool. `tools.alsoAllow`
  on the per-tenant `openclaw.json` includes
  `"nabu-google-workspace"` so it surfaces to the agent.
- **`config.patch` pipeline working:** NestJS's `RMQ →
  google-workspace-plugin.set-token → config.patch` push is verified
  end-to-end. Tenant gateway shows `enabled: true`,
  non-empty `apiToken`, `tokenVersion ≥ 1`.
- **Plugin-side identity guard verified:** the plugin correctly
  refuses to act when `requesterSenderId` is missing — this is the
  behavior we want; the only thing to fix is making sure `user` flows
  through on the dispatch path so the guard doesn't fire on legitimate
  requests.

## 6. Reference

- OpenAI Responses API spec — the `user` field:
  https://platform.openai.com/docs/api-reference/responses/create
- The full Google Workspace integration spec on the NestJS side:
  [google-workspace-nestjs-implementation.md](./google-workspace-nestjs-implementation.md)
- The plugin source:
  [extensions/nabu-google-workspace/src/tools/nabu-google.tool.ts](../../extensions/nabu-google-workspace/src/tools/nabu-google.tool.ts)
- The OpenClaw-side gateway change file list:
  - [src/agents/command/types.ts](../../src/agents/command/types.ts)
  - [src/agents/agent-command.ts](../../src/agents/agent-command.ts)
  - [src/gateway/openresponses-http.ts](../../src/gateway/openresponses-http.ts)
