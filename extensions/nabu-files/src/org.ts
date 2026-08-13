import { LOG_PREFIX } from "./nabu-files.constants.js";

// Shared-instance agents are named `agent-org-<orgId>`; the org is a POSITIVE
// id (app_organizations.id starts at 1), so `agent-org-0` never owns anything.
const SHARED_ORG_AGENT_RE = /^agent-org-([1-9]\d*)$/;

export type OrgSource =
  | { readonly kind: "dedicated"; readonly organizationId: string }
  | { readonly kind: "shared"; readonly organizationId: string };

/**
 * Tenant org for a files-api call: the per-container env var on a dedicated
 * tenant, else the org encoded in a shared-instance `agent-org-<orgId>` agent.
 * The `kind` drives token selection (config token vs brokered); fail-closed.
 */
export function resolveOrgSource(agentId: string | undefined): OrgSource {
  const fromEnv = process.env.OPENCLAW_ORGANIZATION_ID?.trim();
  if (fromEnv) {
    return { kind: "dedicated", organizationId: fromEnv };
  }
  const fromAgent = agentId?.trim().match(SHARED_ORG_AGENT_RE)?.[1];
  if (fromAgent) {
    return { kind: "shared", organizationId: fromAgent };
  }
  throw new Error(
    `${LOG_PREFIX} organization id unresolved: OPENCLAW_ORGANIZATION_ID unset and agentId "${agentId ?? ""}" is not agent-org-<orgId>`,
  );
}
