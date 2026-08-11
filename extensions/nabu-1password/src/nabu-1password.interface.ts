import { OP_OPERATIONS } from "./nabu-1password.constants.js";

/**
 * Plugin config shape — mirrors plugins.entries.nabu-1password.config in
 * openclaw.json. apiToken is the per-deployment skill bearer; apiBaseUrl is the
 * Docker-internal NestJS base.
 */
export interface Nabu1PasswordConfig {
  apiToken: string;
  apiBaseUrl?: string;
}

/**
 * Body POSTed to the token endpoint. 1Password is ORGANIZATION-scoped, so
 * these fields are audit-only — authority is the skill token plus the
 * env-derived `x-organization-id` header (G1). The backend ignores them today.
 */
export interface OpTokenRequest {
  userId: number;
  channel: string;
}

/**
 * Response shape of the token endpoint. token starts with "ops_".
 */
export interface OpTokenResponse {
  token: string;
}

export type OpOperation = (typeof OP_OPERATIONS)[number];

/**
 * Tool params after schema validation, passed to the argv builder.
 */
export interface Nabu1PasswordParams {
  operation: OpOperation;
  reference?: string;
  item?: string;
  vault?: string;
  fields?: string[];
}
