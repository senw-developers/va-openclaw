---
name: nabu-1password
description: Read secrets from the tenant's 1Password vault using the op CLI. Service-account auth is preconfigured by the nabu-1password plugin — use op commands directly. Do NOT run `op signin`, do NOT use tmux, do NOT try the desktop app.
metadata: { "openclaw": { "emoji": "🔐", "requires": { "bins": ["op"] } } }
---

# 1Password (headless, service-account)

The `nabu-1password` plugin has already set `OP_SERVICE_ACCOUNT_TOKEN` in this
process. `op` commands authenticate automatically. This is a headless Docker
container — there is no 1Password desktop app, no keyring, no tmux signin
flow.

## Do NOT

- Do **not** run `op signin`, `op account add`, or any interactive signin.
- Do **not** use tmux. Service-account tokens are stateless.
- Do **not** ask the user for credentials — they are configured on the Nabu
  dashboard and injected by the plugin.

## Common commands

- **Read a secret:**

  ```
  op read "op://VaultName/ItemName/password"
  ```

  Returns the secret value. Common fields: `password`, `credential`, `api_key`.

- **Prefer UUIDs over names when known** — 1 API call instead of 3:

  ```
  op read "op://{vault-uuid}/{item-uuid}/password"
  ```

- **List accessible vaults:**

  ```
  op vault list
  ```

- **List items in a vault:**

  ```
  op item list --vault "VaultName" --format json
  ```

- **Inspect an item's full structure:**

  ```
  op item get "ItemName" --vault "VaultName" --format json
  ```

- **Render a template with many refs in one call** (much faster than a loop):

  ```
  op inject -i template.tpl -o config.yml
  ```

- **Run a command with secrets injected as env vars:**
  ```
  op run --env-file=.env.template -- node app.js
  ```

## Constraints

- **Vault grants are fixed at token creation.** If a needed vault isn't in
  `op vault list`, the tenant must issue a new service-account token in the
  1Password web console with that vault granted — rotation alone does not
  re-scope.
- **Personal / Private / Employee vaults are never accessible** to service
  accounts. Only explicitly shared vaults.
- **Rate limits (Business tier):** 10,000 reads/hour, 50,000 requests/day.
  Each `op read` with item/vault names is 3 API calls; prefer UUIDs or
  `op inject` / `op run` when resolving several refs in one task.

## Errors

| Symptom                           | Likely cause                | Action                                                              |
| --------------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `[ERROR] authentication required` | Token missing or revoked    | Tell the user to open the Nabu dashboard → Integrations → 1Password |
| `[ERROR] "X" isn't an item`       | Wrong vault/item/field path | Verify with `op item list --vault "..."`                            |
| `[ERROR] 429 Too Many Requests`   | Rate limit hit              | Wait ~15 minutes; batch future reads with `op inject`               |
