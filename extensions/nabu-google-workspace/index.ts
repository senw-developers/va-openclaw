import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { getLivePluginConfig } from "./src/config.js";
import { DEFAULT_REFRESH_MS, REFRESH_RPC_METHOD } from "./src/nabu-google-workspace.constants.js";
import { clearTokenCache, logBackendStatus } from "./src/token.js";
import { createNabuGoogleTool } from "./src/tools/nabu-google.tool.js";

/**
 * Per-user Google Drive + Calendar access. The backend owns the long-lived
 * refresh tokens; this plugin caches only short-lived access tokens in memory
 * and clears them on the refresh RPC or gateway stop.
 */
export default definePluginEntry({
  id: "nabu-google-workspace",
  name: "@va-team/nabu-google-workspace",
  description:
    "Per-tenant Google Drive + Calendar access. Vends short-lived OAuth access tokens fetched from the Nabu backend and exposes a single passthrough tool the agent uses against Google REST APIs.",

  register(api: OpenClawPluginApi) {
    // Tool: register the single passthrough tool. The factory shape gives
    // us the per-call OpenClawPluginToolContext, which carries
    // requesterSenderId — the trusted current end-user identity.
    api.registerTool((ctx) => createNabuGoogleTool(api, ctx), { name: "nabu_google" });

    // Hook: gateway_start — log configuration, probe NestJS reachability.
    // Access tokens are NOT pre-warmed: they're per-user and we don't know
    // who will speak first.
    api.on("gateway_start", () => {
      logBackendStatus(api);
    });

    // Periodic re-probe. Cheap; just confirms NestJS is reachable with the
    // current apiToken. NestJS also calls REFRESH_RPC_METHOD on rotate so
    // cache invalidation does not wait for this interval.
    const cfg = getLivePluginConfig(api);
    const intervalMs = cfg.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    const timer = setInterval(() => {
      logBackendStatus(api);
    }, intervalMs);

    // Hook: gateway_stop — drop the cache and stop the timer.
    api.on("gateway_stop", () => {
      clearInterval(timer);
      clearTokenCache();
    });

    // Gateway RPC — NestJS calls this after rotation / re-consent / disconnect
    // to drop the in-memory access-token cache so the next tool call refetches.
    //
    // NestJS call: connection.rpc("nabu.googleworkspace.refresh", {})
    api.registerGatewayMethod(REFRESH_RPC_METHOD, async ({ respond }) => {
      clearTokenCache();
      await logBackendStatus(api);
      respond(true, { ok: true, plugin: api.id });
    });
  },
});
