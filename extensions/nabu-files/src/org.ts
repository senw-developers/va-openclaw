import { LOG_PREFIX } from "./nabu-files.constants.js";

// Shared-instance agents are named `agent-org-<orgId>`; the org is a POSITIVE
// id (app_organizations.id starts at 1), so `agent-org-0` never owns anything.
const SHARED_ORG_AGENT_RE = /^agent-org-([1-9]\d*)$/;

/**
 * Tenant org id for a files-api call: the per-container env var on a dedicated
 * tenant, else the org encoded in a shared-instance `agent-org-<orgId>` agent.
 * Fail-closed so a call never lands unscoped.
 */
export function resolveOrganizationId(agentId: string | undefined): string {
  const fromEnv = process.env.OPENCLAW_ORGANIZATION_ID?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromAgent = agentId?.trim().match(SHARED_ORG_AGENT_RE)?.[1];
  if (fromAgent) {
    return fromAgent;
  }
  throw new Error(
    `${LOG_PREFIX} organization id unresolved: OPENCLAW_ORGANIZATION_ID unset and agentId "${agentId ?? ""}" is not agent-org-<orgId>`,
  );
}
