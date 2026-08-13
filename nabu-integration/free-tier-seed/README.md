# free-tier-seed — the shared free-tier instance

**Developed here, deployed by the orchestrator** (same contract as `../spawn-seed`).

This is the config for the **single shared OpenClaw box that serves the whole
free tier** — openclaw instance name `nabu-free-tier`. It is a sibling of
`../spawn-seed` (the dedicated per-tenant seed), NOT a replacement: the two seed
shapes are near-opposite and coexist. The orchestrator deploys this one once, by
hand (decision I — no allocator, no pairing automation).

## How it differs from `spawn-seed` (and why)

| Aspect                     | spawn-seed (dedicated)                                   | free-tier-seed (shared)                                                      |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `OPENCLAW_ORGANIZATION_ID` | filled per tenant                                        | **empty** — org derived per-request from `agent-org-<orgId>`                 |
| files-api credential       | per-tenant config skill token (`NABU_FILES_SKILL_TOKEN`) | **broker** — `NABU_FREE_TIER_BROKER_TOKEN` mints a per-org token per request |
| product plugins            | email / gsuite / 1password available                     | **only files-api** (+ its companion `nabu-media-upload`)                     |
| tool profile               | `coding` (full shell/fs)                                 | **`messaging`** + session tools denied                                       |
| channels                   | configurable                                             | **off** (decision H)                                                         |
| tenants per box            | one                                                      | many (one sub-agent per free org)                                            |

`nabu-files` is the ONE product plugin enabled here; email, google-workspace,
1password, model-router are disabled; the browser plugin and channel plugins
(telegram/imessage) are removed from `plugins.allow`. Provider plugins (minimax
primary, openai deferred groundwork) and infra (`nabu-gateway`,
`nabu-media-upload`) stay on.

## Security posture (mirrors nabu-senw D5 — hardened, not complex)

One container serves many untrusted free orgs, so isolation rests on THREE cheap
layers, not an OS sandbox jail:

1. **Backend is the sole trusted client.** Every turn arrives with a
   server-derived `model: openclaw:agent-org-<orgId>` — clients cannot pick an
   agent (backend P1). Files isolate by `(organizationId, userId)`, enforced
   backend-side (verified live: cross-org and cross-user resolves return
   NOT_FOUND; a forged `x-organization-id` is rejected 401).
2. **Reduced tool surface** (`agents.defaults` via top-level `tools`):
   `profile: "messaging"` is an allow-list that excludes `exec` / `process` /
   file-write / `browser`, so a free-org agent has no shell, no container-fs
   reach, and no browser. `tools.deny` additionally removes the session tools
   (`sessions_send` / `sessions_list` / `sessions_history`) — `sessions_send` can
   inject into any session, a cross-tenant vector on a shared box.
3. **Channels off + session bindings absent**, so there is no unbound-inbound →
   `main` path to defend (that whole layer is a no-op here).

Because the tool surface gives no `exec` and no container-fs reach,
`agents.defaults.sandbox.mode` stays `off` (senw-style) — the profile _is_ the
isolation. If defense-in-depth is ever wanted it is a one-line change to
`"non-main"` (needs the Docker CLI in the image / `OPENCLAW_SANDBOX=1`).

`agents.list` pins `main` as the default so a first-turn auto-created
`agent-org-<n>` can never hijack the org default. `main` runs the same reduced
profile — on this box it is operator-only; no free org ever routes to it.

## Provisioning notes

- The shared box is paired by hand once (decision G). Its control-plane identity
  and the WS connection the backend dials live in the backend's env
  (`NABU_FREE_TIER_{GATEWAY_URL,GATEWAY_TOKEN,DEVICE_*}`), not here.
- The 10-messages/org/day allowance is enforced entirely backend-side — nothing
  in this seed meters it.
- With `OPENCLAW_ORGANIZATION_ID` empty the Cloudflare `cf-aig-metadata` header
  renders `{"organizationId":""}`; the core config warning at boot naming
  `models.providers.cloudflare-ai-gateway.headers.cf-aig-metadata` is expected
  and non-fatal (minimax is primary; the Cloudflare provider is inert here).

## Standalone local testing

Same as spawn-seed: the primary is `minimax/MiniMax-M2.7`, so `MINIMAX_API_KEY`
from the environment is enough to boot. The broker + files-api path additionally
needs `NABU_FREE_TIER_BROKER_TOKEN` set to the value the backend holds, and a
reachable `NABU_APP_BASE_URL`; without a backend the boot is fine but uploads
fail closed. End-to-end broker/upload/isolation was validated against a live
backend (org2/user2 upload → asset stored, per-org/per-user isolation proven).
