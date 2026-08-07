import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { logBackendStatus } from "./src/token.js";
import { createNabu1PasswordTool } from "./src/tools/nabu-1password.tool.js";

/**
 * Plugin entry — nabu-1password
 *
 * Per-user 1Password read access. The Nabu backend stores each user's encrypted
 * 1Password service-account token and brokers it per call; this plugin holds no
 * token state. A single read-only passthrough tool (`nabu_1password`) resolves
 * op:// references and lists items/vaults, running the native `op` CLI in a
 * child process whose env carries the token only.
 *
 * Lifecycle:
 *  - gateway_start → log config readiness. Tokens are per-user and pulled per
 *    call, so nothing is pre-warmed and there is no cache to invalidate.
 *
 * Docs: https://docs.openclaw.ai/plugins/building-plugins
 */
export default definePluginEntry({
  id: "nabu-1password",
  name: "@va-team/nabu-1password",
  description:
    "Per-user 1Password read access. Brokers a per-user service-account token from the Nabu backend per invocation and runs the native op CLI in a scoped child process. Single read-only passthrough tool.",

  register(api: OpenClawPluginApi) {
    // Factory shape → fresh OpenClawPluginToolContext per call → trusted requesterSenderId.
    api.registerTool((ctx) => createNabu1PasswordTool(api, ctx), { name: "nabu_1password" });

    // Startup readiness log only. No token pre-warm (per-user), no cache to manage.
    api.on("gateway_start", () => {
      logBackendStatus(api);
    });
  },
});
