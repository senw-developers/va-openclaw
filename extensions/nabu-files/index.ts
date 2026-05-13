import {
  definePluginEntry,
  registerMediaResolver,
  registerMediaUploader,
  type MediaResolver,
  type MediaUploader,
  type OpenClawPluginApi,
} from "./api.js";
import { hasApiToken, getLivePluginConfig } from "./src/config.js";
import { LOG_PREFIX, PLUGIN_ID } from "./src/nabu-files.constants.js";
import { resolveFiles } from "./src/resolve.js";
import { getFileIdsForToolCall, uploadFile } from "./src/upload.js";

type MessageWithDetails = {
  details?: { nabuFileIds?: unknown } & Record<string, unknown>;
};

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "@va-team/nabu-files",
  description:
    "Routes outbound tool media and inbound channel attachments to the Nabu Files API on NestJS so binaries live in MinIO/Hetzner instead of accumulating on per-tenant disk.",

  register(api: OpenClawPluginApi) {
    let unregisterUploader: (() => void) | null = null;
    let unregisterResolver: (() => void) | null = null;

    api.on("gateway_start", () => {
      const cfg = getLivePluginConfig(api);
      if (!hasApiToken(cfg)) {
        api.logger.warn(
          `${LOG_PREFIX} apiToken not configured; media uploader NOT registered (local-path fallback active)`,
        );
        return;
      }

      const uploader: MediaUploader = async (input) => {
        const file = await uploadFile(api, input);
        const fileId = file.fileId ?? file.id;
        if (typeof fileId !== "number") {
          throw new Error(
            `${LOG_PREFIX} upload response missing fileId/id (got keys: ${Object.keys(file).join(",")})`,
          );
        }
        return {
          fileId,
          signedUrl: file.signedUrl,
          signedUrlExpiresAt: file.signedUrlExpiresAt,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        };
      };
      unregisterUploader = registerMediaUploader(uploader);

      const resolver: MediaResolver = async (input) => {
        return await resolveFiles(api, [...input.fileIds], {
          ...(input.expirySeconds !== undefined ? { expirySeconds: input.expirySeconds } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
        });
      };
      unregisterResolver = registerMediaResolver(resolver);

      api.logger.info(
        `${LOG_PREFIX} media uploader + resolver registered (apiBaseUrl=${cfg.apiBaseUrl})`,
      );
    });

    api.on("gateway_stop", () => {
      unregisterUploader?.();
      unregisterUploader = null;
      unregisterResolver?.();
      unregisterResolver = null;
    });

    // Stamps details.nabuFileIds onto ToolResultMessages whose media was already
    // uploaded by the media-upload pi extension upstream of persistence.
    api.on("tool_result_persist", (event, _ctx) => {
      const fileIds = getFileIdsForToolCall(event.toolCallId);
      if (fileIds.length === 0) return;

      const messageWithDetails = event.message as unknown as MessageWithDetails;
      const existing = messageWithDetails.details;
      const existingIds = Array.isArray(existing?.nabuFileIds)
        ? (existing.nabuFileIds.filter((n) => typeof n === "number") as number[])
        : [];
      const merged = dedup([...existingIds, ...fileIds]);

      const updated = {
        ...event.message,
        details: {
          ...(typeof existing === "object" && existing !== null ? existing : {}),
          nabuFileIds: merged,
        },
      } as typeof event.message;
      return { message: updated };
    });
  },
});

function dedup(arr: number[]): number[] {
  return Array.from(new Set(arr));
}
