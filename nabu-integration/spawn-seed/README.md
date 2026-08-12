# spawn-seed — ownership contract (maintainer decision, 2026-08-10)

**Developed here, deployed by the orchestrator.**

- This directory is the **development copy** of the tenant seed: all seed
  changes (config, compose, docker-setup.sh, .env.example) land HERE first.
- `va-nabu-orchestrator-nest/seed/` is the **deployed copy**: the maintainer
  manually copies this directory there once a change set has matured.
  The orchestrator repo never edits the seed independently.
- **va-core-nest is authoritative** for product decisions in this chain;
  seed behavior questions route to them (memos on `memory.va.team`).
- Never re-vendor FROM the orchestrator copy back into this one — divergence
  there means a pending sync, not a source of truth.

## Standalone local testing (no backend attached)

The seed's model chain is `openai/gpt-5.5` → `minimax/MiniMax-M2.7`, and the
`openai:default` auth profile is **oauth** — a throwaway test instance has no
oauth material, so drive tests off minimax instead. Everything minimax needs is
already in the seed (provider, `MiniMax-M2.7`, the `minimax:global` api_key
profile, and the compose env passthrough); `MINIMAX_API_KEY` is resolved
straight from the environment, so no `openclaw auth` step is required.

**⚠ Do not commit the primary-model flip into this seed.** `openai` primary is
operator decision G7 and ships to every tenant. Change it on the _instance_
config only:

```sh
# 1. In the instance .env: MINIMAX_API_KEY=…  OPENCLAW_GATEWAY_TOKEN=…
# 2. After docker-setup.sh creates the instance config dir:
openclaw config set agents.defaults.model.primary minimax/MiniMax-M2.7
```

What a standalone image can actually prove:

- **R-3 doctor check** — boot once with `OPENCLAW_ORGANIZATION_ID` empty and
  `openclaw doctor` must ERROR on the `cf-aig-metadata` header; set it and the
  error clears. This is the fastest end-to-end check of the newest code.
- **Seed invariants** — one agent (`main`), pinned as default, and the default
  survives adding a seat.
- **Skill-token degradation (F-4)** — leave every `NABU_*_SKILL_TOKEN` unset:
  plugins must report "allowed but unavailable" while `config.patch` keeps
  working. That is the regression the F-4 revert exists to prevent.
- **Credit latch** — set `nabuEnabled: false` and send an **API** turn; the
  synthetic reply must fire (it was previously cron-only).
- **Per-user session key** — pass a crafted `x-openclaw-session-key` of
  `agent:main:api:<org>:<userId>:<ts>` and confirm the owner resolves, and that
  a `userId` of `0` fails closed.

Not provable without the backend: nabu-email / nabu-files / 1Password / Google
Workspace calls (they need `app:6001`), and R-1's fileRefs enrichment — the
media resolver comes from `nabu-files`, which is `enabled: false`, so the SSE
refresh path runs but enrichment is a no-op.
