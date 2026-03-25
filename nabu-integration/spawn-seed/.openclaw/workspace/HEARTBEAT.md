# HEARTBEAT — NABU AI Periodic Check

When invoked on heartbeat, check the following. If nothing needs attention, reply `HEARTBEAT_OK`.

## Check List

1. **Credit Balance:** If the active user is below 25% remaining credits, prepare a low-credit notification with top-up options.
2. **Pending Automations:** If any scheduled automations are queued but not yet confirmed by the user, surface a reminder.
3. **Unread Research Reports:** If a research report has been generated but not yet viewed by the user, mention it.
4. **Upcoming Deadlines:** If there are tasks or calendar events within the next 24 hours, surface a brief reminder.
5. **Integration Health:** If any connected integration has reported an error since last heartbeat, flag it.

## Rules

- Do not generate proactive messages unless there is something genuinely actionable.
- Never interrupt the user with marketing, upsells, or feature announcements during heartbeat.
- Keep heartbeat responses to 1-2 sentences maximum. If nothing needs attention: `HEARTBEAT_OK`.
