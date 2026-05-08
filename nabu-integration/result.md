## Corrections to assumptions
1. partially right: single VPS is correct in concept, but EU region cannot be confirmed from this side
2. wrong: not K3S, not a `kubernetes` namespace. plain `docker compose`, one stack per org under `nabu-integration/instances/<id>/`
3. partially right: one isolated stack per org (not pod). lazy provisioning is **not automated** today; instances are scaffolded by copying `nabu-integration/spawn-seed/` and setting `OPENCLAW_ORGANIZATION_ID` + `COMPOSE_PROJECT_NAME` in `.env`
4. unknown: nginx on host is plausible but not configured by anything in this repo; the openclaw stack itself does not include or require it
5. unknown: Forge is not referenced in any openclaw-side config or script
6. wrong: device tokens / channel creds live in the per-org `openclaw.json` on a bind-mounted host directory (`./.openclaw`), not in K8s Secrets. paired-state is also under that same dir
7. wrong: no provisioning controller exists. spawning is a manual `cp -r spawn-seed instances/<id> && edit .env && docker compose up -d` today
8. unknown from this side: cross-VPS reachability depends on the API VPS's docker-compose network and how it joins `openclaw-network` (an external bridge). On this dev box both stacks share host-level localhost; production private-IP topology is set on the host, not in this repo
9. partially right: WS (gateway pairing on `:18789`) and HTTP (`/v1/responses`, `/v1/chat/completions` on the same port) are real. "RPC config.patch" is real but uses the same WS pairing channel, not a separate transport
10. mostly right on intent, wrong on what is actually live today (see "Channels (live today)" below)

## Host & orchestration
orchestrator: docker compose (per-org stack)
vps_size: unknown from this side
reverse_proxy: none required by openclaw; gateway port published directly by docker. host nginx may sit in front but is not part of this repo
managed_by: unknown (no Forge config in repo)

## Per-org isolation
unit: docker compose stack (`openclaw-gateway` + `openclaw-cli` containers, sharing one network namespace)
provisioning: manual today; copy `spawn-seed/` → `instances/<id>/`, set `.env`, `docker compose up -d`. seed at `nabu-integration/spawn-seed/.openclaw/openclaw.json`
notes: the `openclaw-cli` container shares the gateway's network namespace via `network_mode: service:openclaw-gateway`. one external bridge `openclaw-network` is reused across all instances on the same host

## Networking
listen_iface: container-internal `0.0.0.0:18789`. the docker port mapping `${OPENCLAW_GATEWAY_PORT:-18789}:18789` publishes on the host's default interface set by docker (typically all interfaces). bind-mode inside openclaw is `lan` (`gateway.bind` in openclaw.json), not `loopback`
ports: { ws: 18789, http: 18789 (same port, openclaw multiplexes), bridge: 18790, admin: n/a (no separate admin UI process), healthz: 18789/healthz }
public_exposure: docker-compose alone publishes on the host's docker-default interface; restricting to a private network is the operator's responsibility (firewall / docker port-bind override). there is no built-in `0.0.0.0` lockdown

## Storage
device_tokens: in `openclaw.json` on the bind-mounted `./.openclaw` host directory (e.g. `channels.telegram.botToken`, `plugins.entries.<id>.config.apiToken`)
paired_state: same `./.openclaw` directory (per-channel paired-state files written by openclaw)
other_state: agent sessions and workspace under `./.openclaw/agents/<id>/sessions/*.jsonl` and `./.openclaw/workspace/`
backups: not configured by this repo

## Channels (live today)
- none enabled in the active `nabu-1` instance; `channels: []` after json parse
- the seed (`spawn-seed`) ships stubs for telegram / whatsapp / discord / slack / imessage / msteams all `enabled: false`, intended to be flipped on per-tenant once creds are pasted
- wiring assumes: telegram = bot token; whatsapp = built-in web pairing (no cloud-api); discord = bot token; slack = botToken + appToken; imessage = local cli + sqlite reader; msteams = appId + appPassword + tenantId
- creds storage in all cases: per-instance `openclaw.json` on the bind-mounted host dir. no secret manager

## Models
gateway: cloudflare-ai-gateway (the only configured `models.providers` entry in the active instance)
providers: [Anthropic via Cloudflare AI Gateway: claude-haiku-4-5, claude-sonnet-4-5, claude-opus-4-6]
selection: per-org via `agents.defaults.model.primary` in the per-instance `openclaw.json`. nabu-1 currently primaries `openai-codex/gpt-5.4` (set via `auth.profiles`, not via `models.providers`)
notes: there is also a `nabu-model-router` plugin doing tier-based routing (`simple → haiku`, `medium → sonnet`, `hard → opus`) with a haiku-based classifier; configured per instance

## Plugins
- nabu-gateway: enabled. usage ingest to NestJS via `${apiBaseUrl}/api/v1/nabu/usage/ingest`. apiBaseUrl in openclaw.json
- nabu-email: enabled. apiToken + apiBaseUrl in openclaw.json (`plugins.entries.nabu-email.config`)
- nabu-1password: enabled. apiToken + apiBaseUrl in openclaw.json. resolves vault secrets for the `op` CLI
- nabu-google-workspace: enabled. apiToken + apiBaseUrl + tokenVersion. exchanges per-org skill apiKey for short-lived per-user Google access tokens via `${apiBaseUrl}/api/v1/google-workspace/access-token`
- nabu-model-router: enabled. apiBaseUrl unused — it talks to the configured `cloudflare-ai-gateway` provider directly
- duckduckgo: enabled (web search)
- cloudflare-ai-gateway, openai: enabled as model providers (not feature plugins)
- token delivery: all `nabu-*` apiTokens live directly in `openclaw.json`. NestJS pushes rotations via the gateway-RPC method (e.g. `nabu.googleworkspace.refresh`) which invalidates in-process caches; the apiToken value itself is updated by NestJS via openclaw's `config.patch` over the same WS channel

## Observability
logs: stdout/stderr → `docker compose logs openclaw-gateway`. no Loki/Sentry/file-sink configured on the openclaw side
errors: same — stderr only. no Sentry DSN in openclaw.json or env
ws_reconnect: openclaw gateway is a server (it accepts WS pairing connections, not the dialer). it does not connect outbound to the API VPS — the API VPS's `nabu-gateway` NestJS process is the one that connects in. reconnect/backoff is the API VPS's concern
restart_behavior: `restart: unless-stopped` on the gateway container. `init: true` for proper PID-1 reaping. on container restart: in-flight HTTP `/v1/responses` and `/v1/chat/completions` requests are dropped (no retry/queue inside openclaw); RMQ-style durability is the API VPS's worker, not openclaw

## Things we missed
- the diagram's "K3S" label is wrong — replace with `docker compose` and put per-org stacks under it as a parallel grid, not pods. the directory pattern is `instances/<id>/{docker-compose.yml,.env,.openclaw/}`
- there is no per-org admin UI process; the only HTTP surface is the gateway itself (`/healthz`, `/v1/responses`, `/v1/chat/completions`, plus the gateway control UI on the same port if `controlUi.allowedOrigins` permits)
- the bridge port 18790 (`OPENCLAW_BRIDGE_PORT`) is exposed alongside 18789 on every instance; what it serves is openclaw-internal (node-bridge), not part of the API↔NABU contract
- there is currently a hard dependency between `apiBaseUrl` set in plugins (`http://app:6001` by default) and the API VPS's docker network. the openclaw stack has its own `openclaw-network` (external bridge); reaching `app:6001` requires the openclaw containers to also be attached to the API VPS's network — that wiring lives in the API VPS's compose, not here
- `OPENCLAW_GATEWAY_TOKEN` is the WS pairing bearer the API VPS uses to authenticate against the openclaw gateway. it lives in both `.env` (openclaw-side) and the API VPS's per-org connection config — must match
- the `openclaw-cli` container is a one-shot init/utility, not a long-running service; it shares the gateway's network namespace and is used for in-container `agent --message` / `config set` invocations
- session/workspace state lives in bind-mounted host dirs (`./.openclaw`, `./.openclaw/workspace`) — survives container restart, lost only if the host dir is wiped
- there is no scheduling layer, no Helm/Kustomize, no service mesh, no CNI (it's docker bridge), no ingress controller, no secret manager
