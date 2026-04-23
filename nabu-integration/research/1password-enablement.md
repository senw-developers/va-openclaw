# 1Password Enablement — Research Brief

> Audience: a research agent doing a second pass. Self-contained. Every claim about this
> codebase has a `file:line` reference so you can verify.
> Do **not** treat recommendations as final; validate against the referenced code and the
> linked upstream docs, then push back on anything that's wrong or incomplete.

## 0. What we mean by "enable 1Password"

OpenClaw exposes 1Password through three distinct surfaces, not one. Any enablement plan has to be explicit about which it touches.

| Surface                           | Role                                                                                                   | Code anchor                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Bundled skill `skills/1password/` | Agent-facing workflow — "use `op read/inject/run` during a task"                                       | `skills/1password/SKILL.md`                                                                            |
| SecretRef `exec` provider         | Gateway-side — resolve provider API keys from 1Password at activation, never store plaintext in config | `docs/gateway/secrets.md:206-233`; providers schema in `src/secrets/` (CODEOWNERS: `@openclaw/secops`) |
| Skill `env` injection             | Pipes env vars (including `OP_SERVICE_ACCOUNT_TOKEN`) into skill tool calls                            | `src/agents/skills/env-overrides.ts:142-209`; shape at `src/config/types.skills.ts:3-8`                |

Operator intent for this deploy (from Q&A):

- Enable the **skill** AND use the **exec SecretRef** pattern — no custom code.
- VPS-bound; **OS-agnostic headless auth** via **1Password Service Account** (`OP_SERVICE_ACCOUNT_TOKEN`).
- No desktop app, no Connect server, no WSL↔Windows interop tricks.

## 1. Environment facts

- Dev host: WSL2 Ubuntu 24.04 (confirmed via `uname -a`; `/etc/os-release`).
- Prod target: generic Linux VPS; deploy surface undecided between [docker-setup.sh](../../docker-setup.sh), [setup-podman.sh](../../setup-podman.sh), [Dockerfile](../../Dockerfile), and systemd on bare metal.
- Current `~/.openclaw/openclaw.json`:
  - `gateway.mode: local`, `bind: lan`, token auth.
  - No `skills.entries`, no `secrets.providers`, no `models.providers`.
  - Last wizard run `2026-04-08`, version `2026.4.9`.
- `op` CLI is **not installed** on the dev host (`which op` → empty).
- The bundled skill only declares a `brew` installer path (`skills/1password/SKILL.md:11-20`) — that's a macOS convenience, not a requirement, and Linux install has to be handled out-of-band.

## 2. How skills are wired (so we know what "enable" actually does)

### 2.1 Discovery

- `loadSkillsFromDirSafe` scans skill directories and parses frontmatter: `src/agents/skills/local-loader.ts:102`.
- Multiple sources stitched together (bundled, managed, workspace, extra): `src/agents/skills/workspace.ts:249`.
- Bundled allowlist narrows which bundled skills are even considered: `src/agents/skills/config.ts:57` + config schema at `src/config/types.skills.ts:42`.

### 2.2 Eligibility (is the skill usable on this host, right now?)

- `shouldIncludeSkill` is the decision point: `src/agents/skills/config.ts:72-104`.
- Gates, in order:
  1. `skills.entries[<name>].enabled === false` → excluded.
  2. Bundled allowlist (if set) must include the skill.
  3. `evaluateRuntimeEligibility` checks `os`, `requires.bins`, `requires.env`, and `always` (`src/agents/skills/config.ts:88-103`).
- For `1password`:
  - `os` → unspecified → allowed everywhere.
  - `requires.bins: ["op"]` → blocks unless `op` resolves via `hasBinary` (`src/agents/skills/config.ts:19`).
  - No `requires.env` → service-account auth is not checked at activation time.
- **Implication:** installing `op` on PATH is sufficient to flip eligibility. No further config needed for the skill to appear.

### 2.3 Invocation

- CLI view: `openclaw skills list` — registered at `src/cli/skills-cli.ts:52`.
- Agent view: skills become slash-commands (`/1password`) via `buildWorkspaceSkillCommandSpecs` (`src/agents/skills/command-specs.ts:60`) and `listSkillCommandsForWorkspace` (`src/auto-reply/skill-commands.ts:22`).
- `disableModelInvocation` frontmatter flag can block auto model invocation (`src/agents/skills/local-loader.ts:83`). The 1password skill does **not** set this, so the model can pull it in.

### 2.4 Env injection into skill runtime

- `SkillConfig.env: Record<string, string>` (`src/config/types.skills.ts:3-8`).
- `applySkillEnvOverridesFromSnapshot` merges that into `process.env` right before skill tool calls: `src/agents/skills/env-overrides.ts:142-209`, specifically injection at `src/agents/skills/env-overrides.ts:202-208`, wired from `src/agents/pi-embedded-runner/run/attempt.ts`.
- So `config.skills.entries["1password"].env.OP_SERVICE_ACCOUNT_TOKEN` WILL be visible to `op` calls the agent makes.
- **Caveat:** this puts a plaintext token on disk in `openclaw.json`, which gets backed up (already `.bak` / `.bak.1` present in `~/.openclaw/`) and synced. Process-level env is strictly safer.

## 3. How SecretRef wiring works (for the exec-provider path)

### 3.1 Contract

- Canonical SecretRef shape and the 1Password exec-provider example live in `docs/gateway/secrets.md:82-233`.
- Exec providers:
  - `command` must be an absolute path; symlinks rejected unless `allowSymlinkCommand: true`.
  - `trustedDirs` required to allow resolved-target validation for package-manager paths.
  - `passEnv` is an **allowlist** — vars not listed are stripped from the subprocess. `OP_SERVICE_ACCOUNT_TOKEN` MUST be listed or `op` runs unauthenticated. See `docs/gateway/secrets.md:178-180`.
  - `jsonOnly: false` lets `op read` return a bare string; `true` would expect JSON.

### 3.2 Activation triggers

- Startup, config reload hot-apply, restart-check, manual `secrets.reload`, and gateway config-write RPC preflight: `docs/gateway/secrets.md:381-397`.
- On file save of `openclaw.json`, the gateway chokidar watcher fires reload: `src/gateway/config-reload.ts:239-261`.
- Secrets-only changes follow the hot-apply path (no process restart): `src/gateway/config-reload.ts:77-82`.
- Atomic-swap contract: runtime snapshot either fully swaps or last-known-good is retained (`docs/gateway/secrets.md:24-27`).

### 3.3 Tools for non-interactive validation

- `openclaw secrets reload` — re-resolve refs, swap snapshot. `src/cli/secrets-cli.ts:58-83`.
- `openclaw secrets audit --check --allow-exec` — actually runs exec providers, exits non-zero on findings. `src/cli/secrets-cli.ts:85-131`; flag meaning documented at `docs/cli/secrets.md:455-458`.
- `openclaw secrets apply --from <plan> [--dry-run] [--allow-exec]` — executes a prepared plan. `src/cli/secrets-cli.ts:241-282`.
- `openclaw secrets configure` exists but is **TTY-required** (`src/cli/secrets-cli.ts:132-240`). Not usable from a deploy script. There is **no non-interactive "register provider" CLI** — edits to `openclaw.json` + `secrets reload` is the headless path.

### 3.4 CODEOWNERS constraint

- `.github/CODEOWNERS` marks `/src/secrets/` (line 13), `/src/gateway/server-methods/secrets*.ts` (line 23), `/docs/gateway/secrets.md` (line 40), `/docs/cli/secrets.md` (line 45) under `@openclaw/secops`. Do not touch those without an owner in the loop.
- `skills/1password/` is **not** in CODEOWNERS → editable.

## 4. The gap: skill doc is desktop-only

The shipped `skills/1password/SKILL.md:34-70` hardwires the workflow to `op signin` + a tmux session for desktop-integration auth. That's correct for macOS workstation users but fatal on a headless VPS:

- No desktop app → `op signin` has nothing to prompt.
- Even on WSL, 1Password's desktop-integration requires 1Password for Linux (or the Windows app + WSL interop), neither of which we're using.
- Service-account tokens bypass signin entirely; `op read` / `op inject` / `op run` work directly.

The skill's **runtime eligibility** doesn't enforce the tmux flow — only the doc does. But an agent reading `SKILL.md` treats the doc as authoritative and will try to open a tmux signin session, fail, and get stuck.

**Minimal fix:** additive edit to `skills/1password/SKILL.md` that introduces an "Auth modes" section and gates the existing workflow under the "desktop integration" mode, preserving it verbatim. Add a "service account" branch that tells the agent to skip signin and use `op whoami` + direct `op read|inject|run`.

## 5. Auth-method decision

Given VPS / OS-agnostic targeting, the realistic headless options:

| Mode                    | Env vars                              | Fit for this deploy                                                        |
| ----------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| **Service account**     | `OP_SERVICE_ACCOUNT_TOKEN`            | ✅ Correct choice. Single env var, scoped to a vault, no external infra.   |
| 1Password Connect       | `OP_CONNECT_HOST`, `OP_CONNECT_TOKEN` | Overkill. Requires self-hosted Connect server; useful only in larger orgs. |
| Desktop app integration | —                                     | ❌ Not applicable on VPS.                                                  |
| WSL interop (`op.exe`)  | —                                     | ❌ Not OS-agnostic; Windows-host-dependent; 30-minute session TTL.         |

Service account is the only mode that runs identically on the WSL2 dev box, on a bare-metal VPS, inside Docker, and in CI.

Sources for the auth-mode landscape:

- [1Password Developer — CLI get-started](https://developer.1password.com/docs/cli/get-started/)
- [1Password Developer — Service accounts](https://developer.1password.com/docs/service-accounts/)
- [1Password Developer — Use the 1Password SSH agent with WSL](https://developer.1password.com/docs/ssh/integrations/wsl/)
- [1Password Community — WSL2 + 1Password CLI](https://www.1password.community/discussions/developers/wsl2--1password-cli/165903)
- [Mykal Machon — Setting up the 1Password CLI on WSL](https://mykalmachon.com/posts/setting-up-the-1-password-cli-on-wsl/)

## 6. Recommended enablement procedure

All steps Linux-first, OS-agnostic where possible. Expand details at implementation time.

1. **Install `op` on the host.**
   - Debian/Ubuntu (apt, signed repo): official install flow per [developer.1password.com/docs/cli/get-started](https://developer.1password.com/docs/cli/get-started/). Produces `/usr/bin/op`.
   - Other distros / containers: tarball download, extract to `/usr/local/bin/op`.
   - Validate with `op --version`.

2. **Provision a 1Password Service Account** (manual, web console): scope to the vault(s) OpenClaw should read. Capture the `ops_...` token.

3. **Export `OP_SERVICE_ACCOUNT_TOKEN` to the gateway process** at the OS level:
   - systemd: drop-in `Environment=OP_SERVICE_ACCOUNT_TOKEN=...` (or `EnvironmentFile=` pointing at a root-0600 file).
   - docker/podman: `--env-file` or orchestrator secret.
   - dev: shell profile; gateway inherits it on `openclaw gateway run`.
   - Do NOT put the token in `~/.openclaw/openclaw.json`.

4. **Patch the bundled skill doc** (`skills/1password/SKILL.md`) additively so the service-account branch exists and is the VPS default. Preserve the tmux flow for desktop users.

5. **Optional — wire a SecretRef exec provider** in `~/.openclaw/openclaw.json` only when a specific credential (e.g. `models.providers.openai.apiKey`) is ready to migrate. Shape per `docs/gateway/secrets.md:206-233`. Must include `OP_SERVICE_ACCOUNT_TOKEN` in `passEnv`.

6. **Verify**:
   - `op whoami` — auth works.
   - `openclaw skills list --json | jq '.[] | select(.name=="1password")'` — skill is eligible.
   - Invoke `/1password` from an agent session — confirm service-account branch is taken.
   - If step 5 done: `openclaw secrets audit --check --allow-exec` → 0; then `openclaw secrets reload` to force the new snapshot.

## 7. Open questions for the second-pass research agent

Please verify these against current 1Password docs and the code references above — I'd rather get corrected now than have the deploy wobble later.

1. **Service-account rate limits.** 1Password's service-account tier caps API calls (documented around their service-accounts page). Is the cap per-account or per-vault, and does the OpenClaw gateway re-resolve refs on every message, or only at activation? From `docs/gateway/secrets.md:19-27` it's activation-time + reload only, but confirm.
2. **`op` CLI version minimum.** The skill declares `requires.bins: ["op"]` but not a version. Does the `exec` provider rely on flags (`--out-file`, `--account`) added in specific `op` versions? Pin a minimum in deploy docs.
3. **Token rotation story.** Service-account tokens are manually rotated. Is there a convention in this repo for triggering `openclaw secrets reload` automatically after a rotation, or is that left to the operator? Check for anything in `src/gateway/` that re-reads process env on SIGHUP.
4. **Skill-doc edit policy.** Is there precedent in this repo for adding an "auth modes" section to a skill? Scan `skills/*/SKILL.md` for any skill that already documents multiple auth paths — mimic that structure to keep the change idiomatic.
5. **Workspace-level skill override.** `config.skills.load.extraDirs` exists (`src/config/types.skills.ts:15-19`). Confirm whether a `~/.openclaw/workspace/skills/1password/SKILL.md` override would **replace** the bundled one in the loader's precedence (`src/agents/skills/workspace.ts:249`). If so, the doc fix could live outside the repo — meaningful for users who don't want to fork.
6. **Docker/podman deploy.** The repo has `docker-setup.sh`, `setup-podman.sh`, `Dockerfile`, `Dockerfile.sandbox*`. Which of these is the VPS path, and does it already layer a secrets-provider binary (age, sops, vault) that we should match in shape for `op`? Consistency matters more than cleverness.
7. **Auth-profiles precedence.** `docs/gateway/secrets.md:372-374` notes `auth-profiles.json` can shadow `openclaw.json` refs (`REF_SHADOWED` audit finding). Confirm there's no `auth-profiles.json` in `~/.openclaw/` that would silently override a future 1P-backed `apiKey` ref.
8. **`nabu-*` extensions and 1Password.** The user is working on Nabu integration (`extensions/nabu-email`, `extensions/nabu-gateway`, `extensions/nabu-model-router`). Do any of these have their own secret surfaces that should be migrated to 1P in the same pass? Briefly scan their manifests / configs.

## 8. Out of scope for this pass

- Migrating any existing credential into 1Password (deferred until a specific credential is chosen).
- Any change to `src/secrets/` or `docs/gateway/secrets.md` — CODEOWNERS restricts.
- Writing a custom 1Password plugin under `extensions/` — built-in surfaces cover the use case.
- Google Workspaces enablement — separate follow-up item the user flagged.

## 9. Reference index

Repo:

- [skills/1password/SKILL.md](../../skills/1password/SKILL.md)
- [skills/1password/references/get-started.md](../../skills/1password/references/get-started.md)
- [skills/1password/references/cli-examples.md](../../skills/1password/references/cli-examples.md)
- [docs/gateway/secrets.md](../../docs/gateway/secrets.md) — canonical SecretRef doc (owners: `@openclaw/secops`)
- [src/agents/skills/config.ts](../../src/agents/skills/config.ts) — skill eligibility
- [src/agents/skills/env-overrides.ts](../../src/agents/skills/env-overrides.ts) — env injection path
- [src/cli/secrets-cli.ts](../../src/cli/secrets-cli.ts) — secrets CLI surface
- [src/gateway/config-reload.ts](../../src/gateway/config-reload.ts) — config watch + hot-apply
- [.github/CODEOWNERS](../../.github/CODEOWNERS)

Upstream:

- [1Password CLI — get-started](https://developer.1password.com/docs/cli/get-started/)
- [1Password CLI — install on Linux](https://support.1password.com/install-linux/)
- [1Password CLI — service accounts](https://developer.1password.com/docs/service-accounts/)
- [1Password CLI — secret references (`op://`)](https://developer.1password.com/docs/cli/secret-reference-syntax/)
- [1Password CLI — `op run` / `op inject`](https://developer.1password.com/docs/cli/secrets-environment-variables/)
- [1Password SSH agent with WSL](https://developer.1password.com/docs/ssh/integrations/wsl/)
