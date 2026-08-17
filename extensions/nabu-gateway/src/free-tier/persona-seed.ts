/**
 * Free-tier shared box: every free org runs as an auto-created `agent-org-<id>`
 * sub-agent whose own workspace is seeded with generic templates, so it would
 * boot as a nameless assistant. This copies the shared Nabu persona into it.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type InternalHookEvent,
  isAgentBootstrapEvent,
  registerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";

/**
 * Backend contract (va-core-nest `resolveAgentId`): shared free-tier orgs route
 * to `agent-org-<orgId>`, dedicated orgs route to `main`. Gating on this makes
 * the seed inert on dedicated boxes, where no `agent-org-*` agent ever runs.
 */
const SHARED_ORG_AGENT_RE = /^agent-org-[1-9]\d*$/;

/**
 * Persona files copied from the shared root into each org workspace, mirroring
 * the real seed. Only SOUL/IDENTITY/TOOLS/AGENTS/USER are bootstrap-injected; the
 * rest are parity docs. MEMORY.md is excluded so each org keeps its own memory.
 */
const PERSONA_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "AGENTS.md",
  "USER.md",
  "GUARDRAILS.md",
  "KNOWLEDGE.md",
  "TEMPLATES.md",
] as const;

/**
 * Org workspaces already handled this process, so repeat turns skip the copy.
 * The workspace layout is stable per process, so an in-memory set is enough.
 */
const seededWorkspaces = new Set<string>();

/**
 * Copies persona files from `personaRoot` into `workspaceDir`, overwriting the
 * generic templates `ensureAgentWorkspace` pre-seeded. Returns the copied
 * name→content map, skipping any file absent at the source (best effort).
 */
export async function copyPersonaIntoOrgWorkspace(
  personaRoot: string,
  workspaceDir: string,
): Promise<Map<string, string>> {
  const copied = new Map<string, string>();
  for (const name of PERSONA_FILES) {
    let content: string;
    try {
      content = await readFile(path.join(personaRoot, name), "utf8");
    } catch {
      // No source file (e.g. a non-free-tier box) — leave the generic template.
      continue;
    }
    try {
      await writeFile(path.join(workspaceDir, name), content);
      copied.set(name, content);
    } catch {
      // A write failure leaves the generic template in place; do not fail the turn.
    }
  }
  return copied;
}

/**
 * agent:bootstrap handler — seeds the Nabu persona into a free-tier org
 * workspace once, then patches the current turn's bootstrap set so even the
 * first message identifies as Nabu.
 */
async function handleAgentBootstrap(event: InternalHookEvent): Promise<void> {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }
  const ctx = event.context;
  if (!SHARED_ORG_AGENT_RE.test(path.basename(ctx.workspaceDir))) {
    return;
  }
  if (seededWorkspaces.has(ctx.workspaceDir)) {
    return;
  }

  // Parent of `.../workspace/agent-org-<n>` is the shared root holding main's
  // Nabu files — guaranteed by resolveAgentWorkspaceDir's non-default branch.
  const copied = await copyPersonaIntoOrgWorkspace(
    path.dirname(ctx.workspaceDir),
    ctx.workspaceDir,
  );
  if (copied.size === 0) {
    // Nothing seeded (transient FS error, or a box with no source persona) —
    // do not mark seeded, so a later turn retries instead of pinning generic.
    return;
  }
  seededWorkspaces.add(ctx.workspaceDir);

  // Bootstrap files were read from disk BEFORE this hook fired, so on a brand-new
  // org workspace they still hold generic content. Replace matching entries in
  // place so THIS turn reflects the seeded persona.
  ctx.bootstrapFiles = ctx.bootstrapFiles.map((file) => {
    const next = copied.get(file.name);
    return next === undefined ? file : { ...file, content: next, missing: false };
  });
}

/**
 * Registers the free-tier persona seed. Inert unless the turn's agent is a
 * shared-org sub-agent, so it is safe to register on every box.
 */
export function registerFreeTierPersonaSeed(): void {
  registerInternalHook("agent:bootstrap", handleAgentBootstrap);
}

/**
 * Clears the seeded-workspace set. Test-only.
 */
export function resetFreeTierPersonaSeedForTest(): void {
  seededWorkspaces.clear();
}
