import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { logInfo } from "../../logger.js";
import { detectMime } from "../../media/mime.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import { ToolInputError, readStringParam, type AnyAgentTool } from "./common.js";
import { resolveMediaToolLocalRoots } from "./media-tool-shared.js";

// Max file size we will hand to the upload pipeline. Constant for v1; a
// config.tools.deliver.maxBytes key is deferred to avoid config-schema drift.
const DELIVER_MAX_BYTES = 100 * 1024 * 1024;

const DeliverToolSchema = Type.Object({
  path: Type.String({
    description: "Absolute or workspace-relative path of the file to deliver to the user.",
  }),
  name: Type.Optional(
    Type.String({ description: "Optional display filename. Defaults to the file's basename." }),
  ),
  mime: Type.Optional(
    Type.String({
      description: "Optional MIME override. Auto-detected from extension if omitted.",
    }),
  ),
});

type DeliverRejectReason = "missing" | "not-file" | "outside-roots" | "oversize";

function isUnder(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function reject(reason: DeliverRejectReason, absPath: string, message: string): never {
  logInfo(`[deliver] rejected reason=${reason} path=${absPath}`);
  throw new ToolInputError(message);
}

export function createDeliverTool(options?: {
  workspaceDir?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Deliver",
    name: "deliver",
    description:
      "Make a file you produced in the workspace downloadable by the user (CSV, XLSX, DOCX, PDF, zip, etc.). The user cannot reach the workspace filesystem; a file is only delivered to them if you call this tool. Provide the file's absolute or workspace-relative path.",
    parameters: DeliverToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawPath = readStringParam(params, "path", { required: true });
      const workspaceRoot = resolveWorkspaceRoot(options?.workspaceDir);
      const abs = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(workspaceRoot, rawPath);

      // Accept the workspace and the agent's own managed media roots
      // (e.g. ~/.openclaw/media where image_generate writes) — the same root
      // set image_generate itself trusts — but nothing outside them.
      const allowedRoots = resolveMediaToolLocalRoots(options?.workspaceDir);
      const rootsToCheck = allowedRoots.length > 0 ? allowedRoots : [workspaceRoot];
      if (!rootsToCheck.some((r) => isUnder(r, abs))) {
        reject(
          "outside-roots",
          abs,
          `path must be inside the workspace or a managed media directory; got: ${abs}`,
        );
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(abs);
      } catch {
        reject("missing", abs, `file not found: ${abs}`);
      }
      if (!stat.isFile()) {
        reject("not-file", abs, `path is not a regular file: ${abs}`);
      }
      if (stat.size > DELIVER_MAX_BYTES) {
        reject(
          "oversize",
          abs,
          `file is ${humanSize(stat.size)}, exceeds the ${humanSize(DELIVER_MAX_BYTES)} delivery limit`,
        );
      }

      const name = readStringParam(params, "name") ?? path.basename(abs);
      const mime = readStringParam(params, "mime") ?? (await detectMime({ filePath: abs }));

      logInfo(`[deliver] accepted path=${abs} sizeBytes=${stat.size} mime=${mime ?? "unknown"}`);

      return {
        content: [{ type: "text" as const, text: `Delivered ${name} (${humanSize(stat.size)})` }],
        details: {
          deliverables: [
            {
              path: abs,
              name,
              ...(mime ? { mime } : {}),
              sizeBytes: stat.size,
            },
          ],
        },
      };
    },
  };
}
