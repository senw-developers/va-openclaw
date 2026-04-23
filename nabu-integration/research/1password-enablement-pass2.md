# 1Password Enablement — Research Brief, Pass 2

> Companion to `1password-enablement.md`. Directly answers the eight open
> questions from §7 of the first brief, corrects/extends the recommendation,
> and surfaces three material things the first pass missed.
> Every external claim has a source; every claim about the repo defers to
> the first brief's file:line anchors (I did not re-walk the OpenClaw tree).

## 0. TL;DR — what changed between pass 1 and pass 2

1. **Rate-limit math is tighter than pass 1 assumed.** `op read` is **3 API calls**, not 1, unless you pass both vault ID and item ID. Combined with tier-specific daily caps (Business 50k/day, Teams 5k/day, Individual/Families 1k/day), this is the single biggest operational fact missing from pass 1. See §2.1.
2. **There is a native JS SDK (`@1password/sdk`).** Pass 1 assumed CLI-only enablement. The WASM-based SDK authenticates directly with a service-account token, no `op` binary required, and is the obvious fit for the NestJS backend side of any 1P integration. Relevant because Nabu's gateway plugin runs inside the NestJS container, not inside OpenClaw. See §3.
3. **1Password shipped Unified Access for AI agents in March 2026** — an MCP-gateway-aware credential-injection platform co-launched with Anthropic, Runlayer, and Natoma. Not a blocker, but it changes the strategic context for how OpenClaw should think about credential exposure to agent sessions. See §4.
4. **Pass 1's recommendation still holds** — service account + env var at the OS/container layer, additive SKILL.md patch, optional exec SecretRef — but the _order of operations_ should change to "JS SDK in NestJS first, OpenClaw skill second, exec SecretRef last." See §7.

## 1. Environment facts not in pass 1

- **Current `op` CLI**: 2.34.0 (April 16, 2026), stable. Service accounts require **≥2.18.0**. Caching for service-account sessions on macOS/Linux was added later — call it ≥2.24 to be safe. Source: [1Password CLI release notes](https://app-updates.agilebits.com/product_history/CLI2).
- **Current JS SDK**: `@1password/sdk@0.4.1-beta.1` (Feb 11, 2026). Still v0.x — "version 0, three months of support and security patches, breaking changes possible between 0.x.y minor releases." Source: [1Password SDKs overview](https://developer.1password.com/docs/sdks/).
- **Docker image**: `1password/op:2-beta` official, ~68MB, Alpine-based. The `1password/op:latest` tag now always points to CLI 2. Source: [Docker Hub 1password/op](https://hub.docker.com/r/1password/op).
- **Forge reality check** (user context): Forge already manages `.env` in site root as a shared path across zero-downtime deploys; `envsubst` templating was removed from the deploy script per the user's recent work. That's the correct seam for 1P integration — the deploy script runs `op inject` to produce the `.env`, Forge keeps it shared.

## 2. Answers to pass 1 open questions

### 2.1 Q1 — Service-account rate limits (pass 1 §7.1)

**Scope is per-token hourly + per-1Password-account daily.** Exact numbers:

| Tier                 | Hourly reads (per token) | Hourly writes (per token) | Daily total (per account) |
| -------------------- | ------------------------ | ------------------------- | ------------------------- |
| 1Password Business   | 10,000                   | 1,000                     | 50,000                    |
| 1Password Teams      | 1,000                    | 100                       | 5,000                     |
| 1Password / Families | 1,000                    | 100                       | 1,000                     |

Source: [Service account rate limits](https://developer.1password.com/docs/service-accounts/rate-limits/).

**The multiplier pass 1 didn't mention:**

| Command                           | Total API calls            | How to reduce                |
| --------------------------------- | -------------------------- | ---------------------------- |
| `op read "op://Vault/Item/field"` | **3**                      | Pass item+vault IDs → 1 call |
| `op item get`                     | 3                          | Pass item+vault IDs → 1 call |
| `op item list`                    | 1 + 1 per accessible vault | `--vault <id>` → 2 calls     |
| `op item create`                  | 1 read + 1 write           | `--vault <id>` → 1 call      |
| `op item edit`                    | 5 reads + 1 write          | `--vault <id>` → 4+1 calls   |

Source: [commands that make multiple requests](https://developer.1password.com/docs/service-accounts/use-with-1password-cli/#commands-that-make-multiple-requests).

**What this means for OpenClaw's exec SecretRef pattern:**

If the exec provider uses `op read "op://<vault>/<item>/<field>"` with **names** (the default), each resolution burns 3 daily quota. On 1Password Teams (5k/day), that's ~1,666 SecretRef resolutions before the daily cap. On Individual (1k/day) it's ~333 — easy to exhaust with one noisy debug session (confirmed failure mode, Jan 2026: [15-minute block with no backoff indicator](https://www.1password.community/discussions/developers/service-account-rate-limits-15-minutes-block-no-backoff-duration-shown/167040)).

**Operational consequence:** If the OpenClaw gateway re-resolves on every reload/restart, dev cycles alone can exhaust the daily quota. Pass 1 §3.2 asserts resolution is activation-time + reload only (citing `docs/gateway/secrets.md:19-27`) — that's correct per the doc, but the _reload trigger list_ (startup, config hot-apply, restart-check, manual `secrets.reload`, preflight) can fire many times an hour during development. Three implications:

1. **Default to Business tier.** 50k/day gives real headroom. Don't try to run production on Individual.
2. **Use item IDs in SecretRefs.** `op://<vault-id>/<item-id>/<field>` cuts resolution from 3 calls to 1. The 26-char IDs are copy-pasteable from `op item get --format json`.
3. **Check `op service-account ratelimit` in `openclaw secrets audit`.** If that CLI hook is viable (outside CODEOWNERS? pass 1 §3.4 says secrets tooling is owned by `@openclaw/secops`), a per-environment quota check at audit time would catch over-resolution before it hits prod.

### 2.2 Q2 — `op` CLI version minimum (pass 1 §7.2)

**Pin ≥2.18.0 for service-account auth as a hard floor, ≥2.24 as a practical floor to get caching, ≥2.33 to get `op environment` support** (if you ever move to 1Password Environments — see §5). The latest (2.34.0) fixes a signal-forwarding bug in `op run` that matters for any process manager that relies on SIGTERM propagation.

Specifically for the exec-provider flags pass 1 worried about:

- `--out-file` / `-o` on `op read` has been stable since the CLI 2 launch (2022). Not a version-pin concern.
- `--account` is stable since CLI 2. Service-account auth doesn't require `--account` at all — the token is scoped to one account by construction.
- `--cache=false` / `OP_CACHE=false` stable since CLI 2.2.

**Recommendation:** pin `OP_CLI_VERSION=2.34.0` (or whatever is latest at deploy time) in the deploy script or Dockerfile `ARG`, and fail loudly on version drift. Don't rely on `1password/op:latest` — that's a moving target and caught people during the CLI 1 → CLI 2 cutover.

Source: [1Password CLI release notes](https://releases.1password.com/developers/cli/), [Use service accounts with 1Password CLI](https://developer.1password.com/docs/service-accounts/use-with-1password-cli/).

### 2.3 Q3 — Token rotation story (pass 1 §7.3)

**Short version: 1Password does not provide a rotation webhook or push notification. You rotate, then tell your infrastructure to reload.**

Mechanics:

- Service account tokens are manually rotated from 1Password.com (`Developer → Service accounts → ⋯ → Rotate`). The old token is revoked immediately on rotation completion; there is no dual-validity grace period.
- If the sign-in address changes, old tokens redirect to the new address **for 30 days** — that's the only grace window built into the product.
- Token prefix is `ops_` — useful for secret-scanning rules (e.g., GitHub's push protection, TruffleHog). Source: [Service account security](https://developer.1password.com/docs/service-accounts/security/).

**No `SIGHUP` pattern exists in 1Password's stack.** The pattern is: external orchestrator updates the environment variable, then signals the consuming process. For OpenClaw specifically (pass 1 §3.2), the `openclaw secrets reload` CLI is the signal — but the _token change_ itself has to come from outside OpenClaw (systemd `EnvironmentFile=`, Docker `--env-file`, or orchestrator secret mount).

**Forge + Docker Compose variant of the rotation workflow:**

1. Rotate token in 1Password web console.
2. Update the Forge site `.env` (either via Forge UI or by running `op inject` from the deploy script after updating the token item in 1P).
3. `docker compose up -d --force-recreate app` — Compose re-reads `.env` on container start. OpenClaw gateway picks up the new `OP_SERVICE_ACCOUNT_TOKEN` from `process.env`.
4. Trigger `openclaw secrets reload` inside the container to re-resolve any exec SecretRefs under the new token.

**Caveat the first brief didn't flag:** vault access on a service account is **immutable after creation**. If a rotated token needs _different_ vault scope, you must create a new service account, not rotate. Source: [Service account security model](https://developer.1password.com/docs/service-accounts/security/#security-model) — "You can't add vault access to a generated service account after creation."

### 2.4 Q4 — Skill-doc edit policy (pass 1 §7.4)

I can't enumerate what other OpenClaw skills look like without the repo. Two concrete grep patterns the next pass should run:

```bash
# skills that declare multiple auth modes
grep -rEl "(auth mode|headless|service account|desktop integration)" skills/*/SKILL.md

# skills that gate their workflow on an env var (same pattern we'd add to 1password)
grep -rEl "requires:\s*$" skills/*/SKILL.md -A5 | grep -E "(env:|bins:)"
```

If another skill already has an "auth modes" or "headless mode" section, mimic its heading hierarchy verbatim. If nothing like it exists, keep the addition small enough that it's obviously additive:

```markdown
## Auth modes

This skill supports two authentication paths. Pick one based on where
the gateway is running.

### Service account (VPS, Docker, CI — the default for non-interactive hosts)

Set `OP_SERVICE_ACCOUNT_TOKEN` in the process environment. Do NOT run
`op signin`. Validate with `op whoami` — a service-account session
returns without any prompt.

### Desktop integration (workstations — preserved for local dev)

[existing §Auth and §Signin content, unchanged]
```

The "don't run `op signin`" line is load-bearing. `op signin` on a headless host without the 1Password desktop app present will block waiting for a TTY prompt that never arrives, and an agent will get stuck exactly as pass 1 §4 predicted.

### 2.5 Q5 — Workspace-level skill override (pass 1 §7.5)

Again, needs repo walk, but the shape of the answer lives in `src/agents/skills/workspace.ts:249` (stitching order) and `src/config/types.skills.ts:15-19` (`config.skills.load.extraDirs`). Two questions for the verifier:

1. When multiple directories contain `skills/1password/SKILL.md`, does the loader take **first-wins** (bundled beats workspace) or **last-wins** (workspace beats bundled)? The answer changes everything — if last-wins, operators can fix the doc without forking.
2. Does `shouldIncludeSkill` (§2.2 of pass 1) run once per stitched entry, or once per unique skill name? If per entry, duplicates might both evaluate and eligibility might short-circuit unexpectedly.

If the loader is first-wins (bundled beats workspace), the additive edit has to go in the repo. If last-wins, workspace-only override is a cleaner path for operators who don't want to fork. Either way, the edit itself is small.

### 2.6 Q6 — Docker/podman deploy shape (pass 1 §7.6)

Pass 1 flagged the choice of deploy surface as undecided. With the user's Forge + Hetzner + Docker Compose setup (from memory, not the brief), the answer is:

**The gateway stack is `docker compose up` on a Hetzner VPS, orchestrated by Forge.** That constrains the token-delivery options:

| Option | Mechanism                                                                  | Fit                                                                            |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A      | Forge writes token into `.env`, Compose passes to container via `env_file` | ✅ Works today, zero new infra, matches current pattern                        |
| B      | Docker secret (`secrets:` in compose, reads from file)                     | ✅ More proper, but requires `docker swarm init` or a secrets driver; overkill |
| C      | `op inject` in entrypoint, reads template `.env` from image                | ❌ Requires `op` CLI in image AND a bootstrap token; doesn't solve the problem |
| D      | Runtime SDK fetch (`@1password/sdk` at NestJS boot)                        | ✅ For NestJS; doesn't apply to OpenClaw gateway (Rust binary)                 |

Option A is the obvious starting point for OpenClaw and matches the pattern the rest of the stack already uses. The token lives in `.env` (Forge-managed, `root:forge 0600` on disk), gets passed into the gateway container as `OP_SERVICE_ACCOUNT_TOKEN`, and the gateway reads it from `process.env`. **No Dockerfile change to the OpenClaw image is strictly required** if the gateway is already reading env vars — which it must be, since SecretRef exec providers depend on exactly that.

The `op` CLI itself, if the exec SecretRef path is used, needs to be installed _inside_ the OpenClaw gateway container. Two ways:

```dockerfile
# Option 1: multi-stage copy from official image (cleanest, ~12MB added)
FROM 1password/op:2 AS op
FROM <openclaw-base>
COPY --from=op /usr/local/bin/op /usr/local/bin/op
```

```dockerfile
# Option 2: apt/apk install (version-pinned)
RUN curl -sSf https://cache.agilebits.com/dist/1P/op2/pkg/v2.34.0/op_linux_amd64_v2.34.0.zip \
  -o /tmp/op.zip \
  && unzip /tmp/op.zip -d /usr/local/bin/ \
  && rm /tmp/op.zip \
  && op --version
```

Option 1 is cleaner and gets automatic security updates if you rebuild regularly. Option 2 is auditable (you can see the exact version pinned). If the OpenClaw image is Alpine-based, Option 1 still works — the binary is statically linked enough to run on Alpine. Source: [Install 1Password CLI on a server](https://developer.1password.com/docs/cli/install-server/).

**One trap specific to Forge + Compose:** if you rotate the token in Forge's `.env` UI but don't restart the container, the gateway keeps using the old cached credentials. Forge's deploy script doesn't force-recreate containers by default; add `docker compose up -d --force-recreate <service>` to the deploy script or accept that rotations require a manual bump.

### 2.7 Q7 — `auth-profiles.json` precedence (pass 1 §7.7)

Pass 1 pointed at `docs/gateway/secrets.md:372-374` for `REF_SHADOWED`. This is a config-audit concern, not a 1Password concern per se, but worth a pre-deploy check:

```bash
# on the VPS, before enabling any exec SecretRef
ls -la ~/.openclaw/auth-profiles.json
openclaw secrets audit --check --allow-exec 2>&1 | grep REF_SHADOWED
```

If `auth-profiles.json` exists and shadows any ref you're planning to migrate, the migration is silently a no-op. Either delete the shadow or explicitly scope the audit to catch it. The first brief already has this flagged as a follow-up — keep it.

### 2.8 Q8 — `nabu-*` extensions and 1Password (pass 1 §7.8)

Pass 1 asked about secret surfaces in `nabu-email`, `nabu-gateway`, `nabu-model-router`. From what I can glean from user memory (not the repo):

- **`nabu-gateway`** talks to the NestJS backend via HTTP (`/api/v1/nabu/usage/ingest`) using internal-network-only endpoints that skip token auth — "a deliberate security tradeoff" per the user's own notes. No provider API keys live here. **No 1P surface needed.**
- **`nabu-email`** — if this sends email, it has SMTP/SendGrid/SES/Postmark credentials somewhere. NestJS's `@sendgrid/mail`, `nodemailer`, `postmark`, and `@aws-sdk/client-sesv2` are all in the root `package.json`, so the NestJS side is doing the sending, not OpenClaw. **Migrate those keys to 1P in the NestJS env first (see §3), not in OpenClaw.**
- **`nabu-model-router`** — this routes LLM calls (Haiku/Sonnet/Opus per the user's roadmap). The API keys (Anthropic, OpenAI, Cloudflare AI Gateway) are the highest-value rotation targets in the whole stack. These need 1P backing **and** rotation discipline.

**Recommendation:** the migration order is NestJS env → OpenClaw `models.providers` exec SecretRefs → `nabu-*` extension-specific secrets, in that sequence, because each step depends on the prior step's vault structure being stable.

## 3. Major thing pass 1 missed — the JS SDK changes the architecture

Pass 1 treats 1Password integration as CLI-only: `op read`, `op inject`, `op run`. That's correct _inside OpenClaw_, which runs as its own process and has a Rust/Go-ish shape. It's wrong for NestJS.

NestJS can use `@1password/sdk` directly:

```typescript
// src/common/modules/one-password/one-password.module.ts
import { createClient, Client } from "@1password/sdk";

@Injectable()
export class OnePasswordService {
  private client: Client;

  async onModuleInit() {
    this.client = await createClient({
      auth: process.env.OP_SERVICE_ACCOUNT_TOKEN,
      integrationName: "nabu-backend",
      integrationVersion: "1.0.0",
    });
  }

  async resolve(secretRef: string): Promise<string> {
    return this.client.secrets.resolve(secretRef);
  }
}
```

This matters because:

1. **No `op` binary in the NestJS container.** Your Dockerfile stays clean. The SDK is WASM + TypeScript.
2. **No subprocess fork per secret.** `op read` forks a process and does 3 API calls + TLS handshake each invocation (~400–700ms measured, [source](https://www.1password.community/discussions/developers/cli-slow-performance/162309)). SDK client is a long-lived WASM instance that keeps an auth session; `resolve()` is one API call in ~400ms, and the daemon-less cache means subsequent reads of the same ref can hit in-memory state. For anything the backend needs at runtime (e.g., per-customer credentials retrieved on demand), this is the difference between viable and not.
3. **`integrationName` is visible in the 1P activity log.** Every secret fetch is attributed to "nabu-backend" rather than an opaque `op` invocation, which helps with the audit story the user will eventually care about for customer-facing SaaS.
4. **SDK respects the same `op://` reference syntax as CLI.** No cognitive overhead switching between tools; secret references are interchangeable across CLI, SDK, and exec providers.

**Caveat:** SDK is 0.4.1-beta and v0.x. 1Password explicitly says breaking changes are possible between 0.x.y minor releases. Pin exactly in `package.json` (`"@1password/sdk": "0.4.1-beta.1"` not `"^0.4.1-beta.1"`), and watch the [GitHub releases](https://github.com/1Password/onepassword-sdk-js/releases) page.

**Where this sits in the migration plan:** NestJS-side secret resolution via SDK can land _before_ any OpenClaw changes. It's a standalone win, low-blast-radius, and it gives you a place to store the service-account token (the NestJS container's `OP_SERVICE_ACCOUNT_TOKEN` env var) that's separate from OpenClaw's. A single token shared across both processes is simpler but blast-radius-wider; two tokens (NestJS scope, OpenClaw scope) is slightly more ops but gives you independent revocation.

Source: [onepassword-sdk-js README](https://github.com/1Password/onepassword-sdk-js), [1Password SDKs overview](https://developer.1password.com/docs/sdks/).

## 4. Second thing pass 1 missed — 1Password Unified Access (March 2026)

1Password announced [Unified Access](https://1password.com/press/2026/mar/1password-unified-access) on March 17, 2026 — a new GA product specifically for AI agent credential governance. Key relevant facts:

- **Anthropic is a launch partner** — Claude, Claude Code, and Cowork will autofill from 1Password vaults via the browser extension and Chrome agent.
- **MCP gateway integrations** — Runlayer and Natoma can inject 1P-backed credentials into MCP sessions at runtime, using `op://` references.
- **"Runtime credential brokering" is on the 2026 roadmap** — 1Password will issue scoped, short-lived credentials to agent/machine workloads at runtime. When this ships, it replaces long-lived service-account tokens for agent use cases.

**Why this matters for OpenClaw/Nabu:**

OpenClaw _is_ an MCP gateway (it exposes tools to agents, exactly the control point Unified Access is targeting). If the product direction is "scoped, short-lived credentials issued at runtime," the exec SecretRef pattern — which resolves a long-lived credential once at activation and caches it in the snapshot — becomes architecturally outdated in ~12 months.

Practical recommendation: **don't invest heavily in building custom OpenClaw plugins for 1P** beyond what pass 1's minimal-fix path already covers. The ecosystem is going to offer a better answer via MCP-gateway integrations (Runlayer/Natoma style) and the runtime credential broker, and you'll want to be in a position to adopt that rather than maintaining a custom abstraction.

The [Runlayer + 1Password blog post](https://1password.com/blog/secure-mcp-credentials-1password-runlayer) is the reference integration shape — credentials stay in 1P, gateway stores a reference, resolution is per-request and logged. That's a template for how the OpenClaw `secrets.*` surface should probably look in a year, if the team has appetite for it.

## 5. Third thing pass 1 missed — 1Password Environments

[1Password Environments](https://developer.1password.com/docs/environments/) is a public beta feature released late 2025 that's specifically designed for `.env`-style secret bundles. It's orthogonal to vaults — an Environment is a named bag of KEY=VALUE pairs, and you can import/export them as `.env` files.

**Local mount** (FIFO named pipe, Mac/Linux only, desktop app required, 10-file cap per device) is NOT useful for VPS/Docker. Hard no.

**Programmatic read** via `op environment read <id>` or `client.environments.read()` in the SDK **is** useful. It collapses what would otherwise be 30+ individual SecretRefs (one per env var) into a single API call. Rate-limit math: 30 individual `op read` calls = 90 API requests; one `op environment read` = 1 request. For the dev/staging/prod `.env` shape the user already has, this is straightforwardly better.

**Caveats:**

- The full feature still says "beta" in the docs. Production use is okay but expect the shape to evolve.
- Requires CLI 2.33+ or SDK with environments support.
- Environments can't hold structured data — flat `KEY=VALUE` only.
- Service accounts get **read-only** access to Environments ([source](https://developer.1password.com/docs/service-accounts/get-started/)); you can't write back from a VPS.

**Decision call, not a recommendation:** I'd skip Environments for this pass. The vault-per-environment pattern ([Flare's Laravel write-up](https://flareapp.io/blog/using-1password-for-laravel-environment-variables) lays it out clearly) is more stable, works on every tier, and doesn't depend on beta features. If you hit the rate limit with many individual SecretRefs in a year, revisit.

## 6. Performance characteristics (not in pass 1)

| Operation                      | Cold                      | Warm                          | Notes                                                |
| ------------------------------ | ------------------------- | ----------------------------- | ---------------------------------------------------- |
| `op read` via CLI              | 650–930ms                 | 400–700ms even with `--cache` | Mostly network round trips to 1P servers (us-east-1) |
| SDK `client.secrets.resolve()` | ~1.3s (WASM + auth)       | ~400ms                        | Per-client-instance warm after first call            |
| `op inject` rendering template | scales linearly with refs | —                             | Batch your renders; don't call per-var               |
| `op environment read`          | 1 API call for whole env  | —                             | If you go the Environments route                     |

Source: benchmarks in [this CLI perf thread](https://www.1password.community/discussions/developers/cli-slow-performance/162309) and [Go SDK issue #36](https://github.com/1Password/onepassword-sdk-go/issues/36).

**Implication for OpenClaw:** pass 1 §3.2 says refs are resolved at activation/reload, not per-message. That's correct and it's the right shape — a 400ms resolution per ref at gateway startup is fine, but 400ms per agent message is not. If you ever see yourself tempted to resolve per-call, stop and architect around it (cache the resolved value in a long-lived struct, invalidate on `secrets.reload`).

## 7. Updated enablement procedure

The pass 1 procedure is correct. I'd re-order it to decouple the two surfaces and front-load the wins:

### Phase 1 — NestJS-side foundation (2–4 hours, no OpenClaw changes)

1. Create 1P vault `nabu-backend-dev` (and `-staging`, `-prod` later). Keep vault-per-environment, not item-prefix-per-environment — simpler access control.
2. Create a service account `nabu-backend-dev` with read access to that one vault. Business tier for headroom (see §2.1).
3. Save the `ops_...` token. Rotate immediately as a test to confirm your rotation workflow works. Set it in the dev machine's shell profile, not in any config file.
4. `npm install @1password/sdk@0.4.1-beta.1` (pin exact). Add `OnePasswordModule` under `src/common/modules/` per the user's own pattern (small, focused modules — see userMemories). Expose `OnePasswordService.resolve(ref)`.
5. Pick one low-risk credential to migrate — e.g. a dev-only SendGrid test key. Write the migration, verify it works, commit. Don't migrate everything at once.
6. Add `OP_SERVICE_ACCOUNT_TOKEN` to the Forge-managed `.env` for dev. Confirm the NestJS container picks it up. Confirm the secret resolves. Log the integration name to verify attribution in the 1P activity log.

### Phase 2 — OpenClaw skill enablement (1 hour)

7. Install `op` CLI in the OpenClaw gateway container (Dockerfile multi-stage, see §2.6, Option 1).
8. Set `OP_SERVICE_ACCOUNT_TOKEN` on the gateway container — same token as Phase 1 if scope is the same, different token if you want independent revocation. Two tokens is cleaner.
9. Patch `skills/1password/SKILL.md` per §2.4 above. Test `openclaw skills list --json | jq '.[] | select(.name=="1password")'` — confirm eligibility flips from `false` to `true`.
10. Invoke `/1password` from an agent session in dev. Confirm the service-account branch is taken (agent should NOT try `op signin`).

### Phase 3 — OpenClaw exec SecretRef (only if Phase 2 is stable, 2 hours)

11. Pick one provider key (e.g. `models.providers.anthropic.apiKey`). Store it in 1P. Copy the vault+item **IDs**, not names (see §2.1 rate-limit math).
12. Add an exec SecretRef to `~/.openclaw/openclaw.json` referencing absolute `/usr/local/bin/op`, with `OP_SERVICE_ACCOUNT_TOKEN` in `passEnv`, shape per `docs/gateway/secrets.md:206-233`.
13. `openclaw secrets audit --check --allow-exec` — expect exit 0. If it fails, check for `REF_SHADOWED` or `auth-profiles.json` shadowing (see §2.7).
14. `openclaw secrets reload` to force the new snapshot.
15. Rotate the migrated credential at the provider (Anthropic console), update the 1P item, run `openclaw secrets reload` again. Confirm new value takes effect. This is the **rotation rehearsal** — do it before you need to rotate under pressure.

### Phase 4 — Migrate remaining credentials (ongoing)

Order suggested by risk/value:

1. LLM provider keys (Anthropic, OpenAI, Cloudflare AI Gateway) — high value, rotated most often.
2. External service keys (SendGrid, Postmark, AWS SES, Stripe).
3. Internal service credentials (Redis password, RabbitMQ credentials, MinIO root key) — only if they're going to persist across deploys.
4. `nabu-email`-specific credentials if any.
5. Everything else.

Each one is a small commit, run through the Phase 3 rehearsal before committing.

## 8. Things still genuinely uncertain (for a pass 3, if needed)

These need actual code inspection, which pass 1's file:line anchors give you access to but I don't:

1. **Does `shouldIncludeSkill` evaluate eligibility lazily or eagerly?** If eager, installing `op` without setting `OP_SERVICE_ACCOUNT_TOKEN` will make the skill appear available but fail on first use. If lazy, operators get a cleaner error message. Affects the "verify" step in the procedure.
2. **What's the bundled-vs-workspace precedence in `workspace.ts:249`?** See §2.5 — affects whether the SKILL.md patch lives in the repo or in a workspace override.
3. **Does `secrets.reload` actually re-read process env, or only re-resolve existing refs?** If only the latter, `OP_SERVICE_ACCOUNT_TOKEN` changes require a full gateway restart. The first brief's §3.2 references hot-apply via `config-reload.ts:77-82` — check whether that path includes env var re-read or only config-file re-read.
4. **Is there a way to get a "usage report" from OpenClaw side showing exec SecretRef call counts?** Important for monitoring rate-limit headroom before you hit it.
5. **Does the `openclaw-network` external Docker network expose any new surface for 1P?** Specifically, if the gateway needs to reach the 1P API (`https://my.1password.com`) but the network restricts egress, that's a blocker. Check the Docker network config.
6. **What happens to `config.patch` RPCs (the Nabu credit-exhaustion mechanism the user built) when exec SecretRef resolution fails?** If a failed resolution makes the whole config load fail, the gateway might not start after a token rotation goes wrong. Atomic-swap contract (pass 1 §3.2) says last-known-good is retained, but the first cold boot after a rotation is a different case.

## 9. Reference index (additions to pass 1)

Upstream (new):

- [Service account rate limits](https://developer.1password.com/docs/service-accounts/rate-limits/) — the canonical numbers
- [Commands that make multiple requests](https://developer.1password.com/docs/service-accounts/use-with-1password-cli/#commands-that-make-multiple-requests) — the `op read` = 3 calls footnote
- [JS SDK GitHub](https://github.com/1Password/onepassword-sdk-js) — SDK for NestJS integration
- [SDK concepts](https://developer.1password.com/docs/sdks/concepts) — desktop vs service-account auth contract
- [Service account security](https://developer.1password.com/docs/service-accounts/security/) — immutability of vault access, `ops_` prefix
- [Install 1Password CLI on a server](https://developer.1password.com/docs/cli/install-server/) — the Docker `FROM 1password/op` pattern
- [1Password CLI release notes](https://releases.1password.com/developers/cli/) — version history
- [1Password Environments](https://developer.1password.com/docs/environments/) — the beta alternative, probably skip this time
- [Unified Access announcement](https://1password.com/press/2026/mar/1password-unified-access) — ecosystem direction
- [Runlayer + 1Password integration](https://1password.com/blog/secure-mcp-credentials-1password-runlayer) — MCP-gateway reference shape
- [CLI performance discussion](https://www.1password.community/discussions/developers/cli-slow-performance/162309) — ~400-700ms per `op read`
- [Rate-limit block incident](https://www.1password.community/discussions/developers/service-account-rate-limits-15-minutes-block-no-backoff-duration-shown/167040) — real failure mode during dev
