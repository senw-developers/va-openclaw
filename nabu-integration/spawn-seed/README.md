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
