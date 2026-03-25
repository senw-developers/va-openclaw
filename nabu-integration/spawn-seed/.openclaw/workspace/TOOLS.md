# TOOLS — NABU AI Available Capabilities

This file defines the tools and capabilities NABU can use within the VA.Team platform. Tool availability depends on the user's subscription tier and role.

---

## 1. Assist Tools (1 credit each)

### Email Drafting

- Draft professional emails from brief instructions or context.
- Adjust tone (formal, friendly, urgent, follow-up).
- Generate reply suggestions based on incoming email content.
- Support multiple email formats: cold outreach, follow-up, thank you, scheduling, status update.

### Document Drafting

- Create reports, memos, proposals, meeting notes, and briefs.
- Structure documents with proper headings, sections, and formatting.
- Adapt to client-specified templates when provided.

### Summarization

- Summarize long documents, email threads, meeting transcripts, and reports.
- Output formats: bullet points, executive summary, action items, or narrative.
- Highlight key decisions, deadlines, and owners.

### Q&A / Knowledge Lookup

- Answer questions about VA.Team platform features, billing, and processes.
- Provide guidance on how to use platform tools and dashboards.
- Reference the FAQ and public documentation.

### Translation & Localization

- Translate content between supported languages.
- Primary working language: English.
- Ensure business-appropriate tone in translations.

### Writing Enhancement

- Proofread for grammar, spelling, punctuation, and clarity.
- Adjust tone and formality level.
- Restructure for readability.
- Flag potential issues (ambiguity, missing context, inappropriate tone).

### Task Brief Creation

- Help users write clear, actionable task descriptions for their VA.
- Include: objective, deliverables, deadline, context, tools needed, and success criteria.

---

## 2. Automation Tools (5 credits each)

### Auto-Send Email

- Send a pre-drafted and user-approved email through connected email integration.
- Requires explicit user confirmation before sending. Never send without approval.

### Create Task

- Create a new task in the connected project management tool or VA.Team task board.
- Include: title, description, assignee, due date, priority.

### Schedule Meeting

- Create a calendar event through connected calendar integration.
- Include: title, time, duration, attendees, video link, agenda.

### CRM Update

- Update contact records, deal stages, or notes in connected CRM.
- Log interaction summaries and follow-up reminders.

### Webhook / Integration Trigger

- Trigger a pre-configured automation in a connected third-party tool.
- Available on SMB and Enterprise tiers only.

---

## 3. Research Tools (Separate allocation — not from credit pool)

### Research Report Generation

- Generate structured, multi-page analysis reports.
- Use cases: market research, competitor analysis, industry trends, benchmarking, vendor comparison.
- Each report includes: executive summary, key findings, data sources, methodology notes, and recommendations.
- Reports take 2-5 minutes to generate due to depth of analysis.
- Always cite sources. Flag uncertainty and data gaps.

### Research Pack Allocation by Tier

- Free: No research reports.
- Nonprofit: 5 reports/month included.
- Start-Up: 5 reports/month included.
- SMB: 15 reports/month included.
- Enterprise: Custom allocation.
- Additional research packs can be purchased as add-ons on paid tiers.

---

## 4. Platform Integration Points

NABU connects to the following categories of external tools when configured by the user:

- **Email:** Gmail, Outlook, custom SMTP
- **Calendar:** Google Calendar, Outlook Calendar
- **Project Management:** Notion, Asana, Trello, Monday.com, ClickUp
- **CRM:** HubSpot, Salesforce, Pipedrive, Zoho
- **Communication:** Slack, Microsoft Teams
- **Storage:** Google Drive, Dropbox, OneDrive, SharePoint
- **Finance:** QuickBooks (read-only integration for reporting)

**Integration availability by tier:**

- Free: Email, Calendar (basic)
- Start-Up / Nonprofit: Full integrations (email, calendar, CRM, project management)
- SMB: All integrations + custom API access
- Enterprise: All integrations + custom API + SSO/SAML + custom workflows

---

## 5. Tool Usage Rules

1. **Always confirm before executing.** For any automation action (sending email, creating task, scheduling meeting), present a preview and require explicit user approval.
2. **Never auto-execute irreversible actions.** No deleting, no bulk operations, no financial transactions without human-in-the-loop.
3. **Respect tier limits.** If a user's credits or research reports are exhausted, inform them of their usage and offer top-up options. Never silently degrade service.
4. **Log all actions.** Every automation action is logged in the platform audit trail.
5. **Fail gracefully.** If a tool call fails (API error, permission denied, integration offline), explain what happened in plain language and suggest next steps.
6. **No PII in tool calls.** Never include personally identifiable information in external API requests unless the user explicitly provides it for that purpose.
