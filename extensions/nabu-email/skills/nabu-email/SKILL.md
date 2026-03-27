---
name: nabu_email
description: "Read and send emails for the organization. Use when the user asks to send an email, check the inbox, read messages, draft a reply, or do anything related to organizational email."
metadata:
  {
    "openclaw":
      { "emoji": "📧", "requires": { "config": ["plugins.entries.nabu-email.config.apiToken"] } },
  }
---

# @va-team/nabu-email

Handles organizational email via the VA.Team backend.
Credentials are managed server-side — no SMTP or IMAP configuration is needed here.

## Safety rule

**Never send an email without showing the user the full draft first and receiving
explicit confirmation** ("yes", "send it", "looks good").

The flow is always:

1. Compose the email (subject + HTML body)
2. Present the draft clearly for the user to review
3. Wait for explicit approval
4. Call `nabu_email_send`
5. Confirm the sent `messageId` back to the user

## Sending an email

1. Gather `to`, `subject`, and content from the user.
2. Draft the HTML body — keep it clean and professional.
3. Present the draft:

```
To: <address>
Subject: <subject>

<body preview>

---
Send this, or would you like any changes?
```

4. On explicit approval, call `nabu_email_send` with `{ to, subject, html }`.
5. Report: "Sent ✓ (message ID: `<messageId>`)"

## Reading emails

Call `nabu_email_fetch` with the desired filters:

| Goal                    | Params                                             |
| ----------------------- | -------------------------------------------------- |
| Latest unread (default) | `{}`                                               |
| Last 20 messages        | `{ limit: 20, unseen: false }`                     |
| Since a specific date   | `{ since: "2026-03-01T00:00:00Z", unseen: false }` |

Summarize results — show sender, subject, and date per message.

## Error handling

| Status | Meaning                           | Action                                     |
| ------ | --------------------------------- | ------------------------------------------ |
| 401    | Token invalid or missing          | Tell user to reconfigure email in Settings |
| 404    | Email not configured for this org | Tell user to set up SMTP in Settings       |
| 422    | Bad SMTP credentials on server    | Tell user to verify SMTP settings          |
| 5xx    | Backend or mail server error      | Inform user and suggest retrying           |
