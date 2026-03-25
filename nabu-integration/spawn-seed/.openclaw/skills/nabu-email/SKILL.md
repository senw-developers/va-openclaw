---
name: nabu-email
description: "Read and send emails for the organization. Use when the user asks to send an email, check the inbox, read messages, draft and send a reply, or do anything related to organizational email."
version: 1.0.0
metadata:
  {
    "openclaw":
      {
        "requires": { "config": ["plugins.entries.nabu-email.config.apiToken"] },
        "primaryEnv": "",
        "emoji": "📧",
      },
  }
---

# NABU Email

Handles organizational email via the VA.Team backend. Credentials are managed
server-side — no SMTP/IMAP configuration is needed here.

## Safety rule

**Never send an email without showing the user the full draft first and receiving
explicit confirmation** ("yes", "send it", "looks good", etc.).

The flow is always:

1. Compose the email (subject + HTML body)
2. Present it to the user for review
3. On approval, call `nabu_email_send`
4. Confirm the sent `messageId` back to the user

---

## Sending an email

1. Gather `to`, `subject`, and the desired content from the user.
2. Draft the HTML body — keep it clean and professional.
3. Present the draft clearly:

```
To: <address>
Subject: <subject>

<body preview>

---
Send this, or would you like any changes?
```

4. Wait for explicit approval.
5. Call `nabu_email_send` with `{ to, subject, html }`.
6. Report back: "Sent ✓ (message ID: `<messageId>`)"

---

## Reading emails

Call `nabu_email_fetch` with the desired options:

| Want             | Params                                             |
| ---------------- | -------------------------------------------------- |
| Latest 10 unread | `{}` (defaults)                                    |
| Last 20 messages | `{ limit: 20, unseen: false }`                     |
| Since a date     | `{ since: "2026-03-01T00:00:00Z", unseen: false }` |

Summarize results — show sender, subject, and date per message.
For full body content, fetch with a narrower `limit: 1` and `unseen: false`
and describe the content to the user.

---

## Error handling

| HTTP status | Meaning                           | Action                                     |
| ----------- | --------------------------------- | ------------------------------------------ |
| 401         | Token invalid or missing          | Tell user to reconfigure email in settings |
| 404         | Email not configured for this org | Tell user to set up SMTP in settings       |
| 422         | Bad SMTP credentials on server    | Tell user to check SMTP settings           |
| 5xx         | Backend or mail server error      | Inform user and suggest retrying           |
