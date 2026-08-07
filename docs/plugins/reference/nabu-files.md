---
summary: "Routes outbound tool media and inbound channel attachments to the Nabu Files API on NestJS so binaries live in MinIO/Hetzner instead of accumulating on disk. Composed tenancy: every upload/resolve carries x-organization-id (env-derived, one gateway stack per org) AND a numeric x-user-id for per-user ownership."
read_when:
  - You are installing, configuring, or auditing the nabu-files plugin
title: "Nabu Files plugin"
---

# Nabu Files plugin

Routes outbound tool media and inbound channel attachments to the Nabu Files API on NestJS so binaries live in MinIO/Hetzner instead of accumulating on disk. Composed tenancy: every upload/resolve carries x-organization-id (env-derived, one gateway stack per org) AND a numeric x-user-id for per-user ownership.

## Distribution

- Package: `@va-team/nabu-files`
- Install route: included in OpenClaw

## Surface

plugin
