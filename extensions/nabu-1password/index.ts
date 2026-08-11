import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { logBackendStatus } from "./src/token.js";
import { createNabu1PasswordTool } from "./src/tools/nabu-1password.tool.js";

/**
 * Read-only 1Password access. The backend brokers the service-account token
 * per call, so the plugin holds no token state and needs no cache; `op` runs
 * in a child process whose env carries the token alone.
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
