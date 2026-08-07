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
 * Request body POSTed to the access-token endpoint. userId is the trusted
 * requesterSenderId coerced to the backend's integer user id; channel is the
 * trusted gateway channel id. Org rides the x-organization-id header
 * (env-derived, one gateway stack per org — G1), not this body.
 */
export interface OpTokenRequest {
  userId: number;
  channel: string;
}

/** Response shape of POST /api/v1/onepassword/access-token. token starts with "ops_". */
export interface OpTokenResponse {
  token: string;
}

export type OpOperation = (typeof OP_OPERATIONS)[number];

/** Tool params after schema validation, passed to the argv builder. */
export interface Nabu1PasswordParams {
  operation: OpOperation;
  reference?: string;
  item?: string;
  vault?: string;
  fields?: string[];
}
