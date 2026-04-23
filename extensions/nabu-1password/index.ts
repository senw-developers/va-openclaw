import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { getLivePluginConfig } from "./src/config.js";
import { DEFAULT_REFRESH_MS, REFRESH_RPC_METHOD } from "./src/nabu-1password.constants.js";
import { clearToken, refreshToken } from "./src/token.js";

/**
 * Plugin entry — nabu-1password
 *
 * Injects the tenant's 1Password service-account token into the gateway's
 * `process.env` so the `op` CLI works transparently via the agent's exec
 * tool. Zero agent-facing tools — this plugin only manages an env var.
 *
 * Lifecycle:
 *  - gateway_start           → fetch current ops_ from NestJS, set env.
 *  - periodic (default 6h)   → re-fetch in case of tenant-side rotation.
 *  - nabu.onepassword.refresh → RPC NestJS calls to force-refresh after
 *                               a rotation lands through config.patch.
 *  - gateway_stop            → scrub env and clear the timer.
 *
 * Docs: https://docs.openclaw.ai/plugins/building-plugins
 */
export default definePluginEntry({
  id: "nabu-1password",
  name: "@va-team/nabu-1password",
  description:
    "Injects the tenant's 1Password service-account token into gateway process.env so op CLI works transparently via exec.",

  register(api: OpenClawPluginApi) {
    // -----------------------------------------------------------------------
    // Hook: gateway_start — prime process.env at startup so the very first
    // exec call sees the token. Exec children inherit process.env by default
    // (see src/process/exec.ts — baseEnv defaults to process.env).
    // -----------------------------------------------------------------------
    api.on("gateway_start", async () => {
      await refreshToken(api);
    });

    // -----------------------------------------------------------------------
    // Periodic refresh. 1Password service-account tokens don't auto-expire
    // (default), but tenants may rotate without notice. The 6h interval is
    // the fallback; NestJS also calls REFRESH_RPC_METHOD on upsert/rotate
    // to cut rotation-to-effect latency to seconds.
    // -----------------------------------------------------------------------
    const cfg = getLivePluginConfig(api);
    const intervalMs = cfg.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    const timer = setInterval(() => {
      void refreshToken(api);
    }, intervalMs);

    // -----------------------------------------------------------------------
    // Hook: gateway_stop — clear the timer and scrub the token from
    // process.env. String values in V8 heap are GC-deferred and not
    // zeroable from JS; we accept that JS-language constraint.
    // -----------------------------------------------------------------------
    api.on("gateway_stop", () => {
      clearInterval(timer);
      clearToken();
    });

    // -----------------------------------------------------------------------
    // Gateway RPC — NestJS calls this after a config.patch rotation so the
    // plugin picks up the new ops_ immediately.
    //
    // NestJS call: connection.rpc("nabu.onepassword.refresh", {})
    // -----------------------------------------------------------------------
    api.registerGatewayMethod(REFRESH_RPC_METHOD, async ({ respond }) => {
      await refreshToken(api);
      respond(true, { ok: true, plugin: api.id });
    });
  },
});
