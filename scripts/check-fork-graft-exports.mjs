#!/usr/bin/env node

/**
 * Guards fork-critical exports that a take-theirs upstream merge can silently
 * delete without a compile error (the June-2026 merge nearly dropped
 * parseSessionOwner — an authorization bypass, not a build failure).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Source files and the fork exports that must survive in them. Deleting any of
 * these silently degrades owner-identity authz or the Files-API media path.
 */
const REQUIRED_SOURCE_EXPORTS = [
  ["src/sessions/session-key-utils.ts", ["parseSessionOwner"]],
  [
    "src/sessions/session-key-shapes.ts",
    ["DM_MARKERS", "HTTP_USER_PREFIXES", "TAIL_FAIL_CLOSED_TOKENS"],
  ],
  ["src/plugin-sdk/media-uploader.ts", ["registerMediaUploader", "getMediaUploader"]],
  ["src/plugin-sdk/media-resolver.ts", ["registerMediaResolver", "getMediaResolver"]],
  ["src/pairing/pairing-store.ts", ["rejectChannelPairingCode"]],
];

/**
 * Module-unique marker strings for the singleton dual-load check: if tsdown
 * inlines one of these modules into more than one dist chunk, registrations in
 * one copy become invisible to getters in another (silent media no-op, #8).
 */
const SINGLETON_DIST_MARKERS = [
  ["plugin-sdk/media-uploader]", "src/plugin-sdk/media-uploader.ts"],
  ["plugin-sdk/media-resolver]", "src/plugin-sdk/media-resolver.ts"],
];

/**
 * Returns missing export names for one source file (naive text scan is enough:
 * every guarded export is a top-level `export function|const|type NAME`).
 */
function findMissingExports(filePath, names) {
  const absolute = path.join(repoRoot, filePath);
  if (!fs.existsSync(absolute)) {
    return names.map((name) => `${name} (file missing)`);
  }
  const content = fs.readFileSync(absolute, "utf8");
  return names.filter(
    (name) => !new RegExp(`export (async )?(function|const|type|class) ${name}\\b`).test(content),
  );
}

/**
 * Counts dist chunks containing a module-unique marker; more than one means
 * the singleton module was duplicated across chunks.
 */
function countDistChunksWithMarker(distDir, marker) {
  const hits = [];
  const stack = [distDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".js") && fs.readFileSync(full, "utf8").includes(marker)) {
        hits.push(path.relative(distDir, full));
      }
    }
  }
  return hits;
}

/**
 * Runs both guard modes; dist mode is skipped (with a note) when no build
 * output exists so the source guard stays cheap enough for every lane.
 */
export async function main() {
  const failures = [];

  for (const [filePath, names] of REQUIRED_SOURCE_EXPORTS) {
    for (const missing of findMissingExports(filePath, names)) {
      failures.push(`${filePath}: missing fork export ${missing}`);
    }
  }

  const distDir = path.join(repoRoot, "dist");
  if (fs.existsSync(distDir)) {
    for (const [marker, source] of SINGLETON_DIST_MARKERS) {
      const hits = countDistChunksWithMarker(distDir, marker);
      if (hits.length > 1) {
        failures.push(
          `${source}: singleton module bundled into ${hits.length} dist chunks (${hits.join(", ")}) — registrations and getters would not share state`,
        );
      }
    }
  } else {
    console.log("check-fork-graft-exports: dist/ absent, skipped singleton dual-load check");
  }

  if (failures.length > 0) {
    console.error("Fork graft-export guard failed:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log("check-fork-graft-exports: OK");
}

runAsScript(import.meta.url, main);
