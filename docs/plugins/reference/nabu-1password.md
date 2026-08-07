---
summary: "Per-user 1Password read access. Brokers a per-user 1Password service-account token from the Nabu backend per invocation and runs the native op CLI in a scoped child process. Exposes a single read-only passthrough tool the agent uses to resolve secret references and list items/vaults."
read_when:
  - You are installing, configuring, or auditing the nabu-1password plugin
title: "Nabu 1password plugin"
---

# Nabu 1password plugin

Per-user 1Password read access. Brokers a per-user 1Password service-account token from the Nabu backend per invocation and runs the native op CLI in a scoped child process. Exposes a single read-only passthrough tool the agent uses to resolve secret references and list items/vaults.

## Distribution

- Package: `@va-team/nabu-1password`
- Install route: included in OpenClaw

## Surface

contracts: tools; skills
