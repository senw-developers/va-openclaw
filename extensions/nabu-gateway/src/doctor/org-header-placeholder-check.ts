import {
  type HealthCheck,
  type HealthFinding,
  type OpenClawConfig,
  registerHealthCheck,
} from "openclaw/plugin-sdk/health";

const CHECK_ID = "nabu-gateway/org-header-placeholder";
const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Provider header config paths whose values are sent to an upstream. An
 * unresolved ${VAR} here ships the literal placeholder to a third party (e.g.
 * the org id in cf-aig-metadata to Cloudflare), so a missing env var must fail.
 */
function collectProviderHeaderStrings(cfg: OpenClawConfig): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const providers = (cfg as { models?: { providers?: unknown } }).models?.providers;
  if (!providers || typeof providers !== "object") {
    return out;
  }
  for (const [providerId, providerRaw] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerRaw || typeof providerRaw !== "object") {
      continue;
    }
    const provider = providerRaw as { headers?: unknown; request?: { headers?: unknown } };
    const headerGroups: Array<readonly [string, unknown]> = [
      [`models.providers.${providerId}.headers`, provider.headers],
      [`models.providers.${providerId}.request.headers`, provider.request?.headers],
    ];
    for (const [label, headers] of headerGroups) {
      if (!headers || typeof headers !== "object") {
        continue;
      }
      for (const [headerName, headerValue] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof headerValue === "string") {
          out.push({ path: `${label}.${headerName}`, value: headerValue });
        }
      }
    }
  }
  return out;
}

/**
 * Findings for provider header values that reference an env var absent from
 * `env`. The literal ${VAR} would otherwise be sent verbatim upstream (R-3).
 */
export function findUnresolvedHeaderPlaceholders(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const { path, value } of collectProviderHeaderStrings(cfg)) {
    for (const match of value.matchAll(ENV_PLACEHOLDER_RE)) {
      const varName = match[1];
      const resolved = env[varName];
      if (resolved === undefined || resolved.trim() === "") {
        findings.push({
          checkId: CHECK_ID,
          severity: "error",
          message: `Provider header references \${${varName}}, which is unset — the literal placeholder would be sent upstream.`,
          path,
          target: varName,
          fixHint: `Set ${varName} in the gateway environment before the provider is called.`,
        });
      }
    }
  }
  return findings;
}

/**
 * Fails doctor when an unresolved ${VAR} sits on an outbound provider header,
 * closing the R-3 fail-open where a missing org id ships as a literal string.
 */
export const orgHeaderPlaceholderCheck: HealthCheck = {
  id: CHECK_ID,
  kind: "plugin",
  description: "Provider headers resolve every env placeholder before sending.",
  source: "nabu-gateway",
  detect(ctx) {
    return Promise.resolve(findUnresolvedHeaderPlaceholders(ctx.cfg, process.env));
  },
};

let registered = false;

/**
 * ⚠ INERT: core has no generic plugin→doctor seam (bundled-health-checks.ts
 * hardcodes `policy`), so this never reaches the registry, and the orchestrator
 * never runs doctor. R-3 is REOPENED — see nabu-integration/tech-debt.md.
 */
export function registerNabuGatewayDoctorChecks(host?: {
  registerHealthCheck: (check: HealthCheck) => void;
}): void {
  if (registered) {
    return;
  }
  const register = host?.registerHealthCheck ?? registerHealthCheck;
  register(orgHeaderPlaceholderCheck);
  registered = true;
}
