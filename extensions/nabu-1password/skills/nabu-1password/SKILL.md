---
name: nabu-1password
description: Resolve 1Password secrets and list items/vaults for the current end user. Auth is brokered server-side — call the nabu_1password tool, do NOT run `op signin` and do NOT ask the user for a token. Read-only — read secret references, get/list items, list vaults; no create/edit/delete/rotate.
metadata:
  {
    "openclaw":
      {
        "emoji": "🔐",
        "requires":
          { "bins": ["op"], "config": ["plugins.entries.nabu-1password.config.apiToken"] },
      },
  }
---

# 1Password (read-only)

Use the `nabu_1password` tool to read the current user's 1Password secrets. The
plugin brokers a per-user service-account token automatically — never ask the
user for credentials and never run `op signin`.

## Tool

`nabu_1password({ operation, reference?, item?, vault?, fields? })`

| operation    | args                                  | returns                                |
| ------------ | ------------------------------------- | -------------------------------------- |
| `read`       | `reference: "op://vault/item/field"`  | `{ ok, value }` — the plaintext secret |
| `item-get`   | `item` (+ optional `vault`, `fields`) | `{ ok, result }` — item JSON           |
| `item-list`  | optional `vault`                      | `{ ok, result }` — array of items      |
| `vault-list` | none                                  | `{ ok, result }` — array of vaults     |

### Examples

```
nabu_1password({ operation: "read", reference: "op://NABU/Stripe/credential" })
nabu_1password({ operation: "item-get", item: "Stripe", vault: "NABU", fields: ["username", "credential"] })
nabu_1password({ operation: "item-list", vault: "NABU" })
nabu_1password({ operation: "vault-list" })
```

## Result envelope

- Success: `{ operation, ok: true, value | result, truncated? }`.
- Failure: `{ operation, ok: false, error, code?, stderr? }`.

## Do NOT

- Do not run `op signin`, use the desktop app, or ask the user for a token — auth is automatic and per-user.
- Do not attempt create / edit / delete / rotate — this tool is read-only.
- Treat retrieved secret values as sensitive: use them for the task at hand, do
  not echo them more than necessary, and never paste them into untrusted destinations.

## Errors

- `... hasn't connected 1Password` — the user must connect 1Password in the Simon Says dashboard.
- `not found` — re-check the item / vault name or the `op://` reference.
- `op auth failed` — the user's 1Password token lacks access to that vault/item, or needs reconnecting.
- `op timed out` — retry once.
