// Nabu media-upload plugin entrypoint. Registers a tool-result middleware that
// uploads agent media to the Nabu Files API (Path A: bundled plugin so core
// stays extension-agnostic; replaces the former core agent-hook).
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMediaUploadAgentToolResultMiddleware } from "./src/middleware.js";

export default definePluginEntry({
  id: "nabu-media-upload",
  name: "@va-team/nabu-media-upload",
  description:
    "Uploads agent tool-result media to the Nabu Files API and rewrites content/details with signed URLs and web file refs.",
  register(api) {
    api.registerAgentToolResultMiddleware(createMediaUploadAgentToolResultMiddleware(), {
      runtimes: ["openclaw"],
    });
  },
});
