import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyPersonaIntoOrgWorkspace,
  registerFreeTierPersonaSeed,
  resetFreeTierPersonaSeedForTest,
} from "./persona-seed.js";

const PERSONA = {
  "SOUL.md": "# SOUL — NABU AI",
  "IDENTITY.md": "# IDENTITY — NABU AI",
  "TOOLS.md": "# TOOLS",
  "AGENTS.md": "# AGENTS",
  "USER.md": "# USER",
  "GUARDRAILS.md": "# GUARDRAILS",
  "KNOWLEDGE.md": "# KNOWLEDGE",
  "TEMPLATES.md": "# TEMPLATES",
} as const;

type Dirs = { personaRoot: string; orgDir: string };

/**
 * Builds a shared workspace root carrying the Nabu persona plus MEMORY.md, and a
 * child `agent-org-7` workspace pre-seeded with generic templates.
 */
async function setup(): Promise<Dirs> {
  const root = await mkdtemp(path.join(tmpdir(), "nabu-persona-"));
  const personaRoot = path.join(root, "workspace");
  const orgDir = path.join(personaRoot, "agent-org-7");
  await mkdir(orgDir, { recursive: true });
  for (const [name, content] of Object.entries(PERSONA)) {
    await writeFile(path.join(personaRoot, name), content);
  }
  await writeFile(path.join(personaRoot, "MEMORY.md"), "operator private memory");
  await writeFile(path.join(orgDir, "SOUL.md"), "# generic assistant");
  await writeFile(path.join(orgDir, "IDENTITY.md"), "# generic identity");
  return { personaRoot, orgDir };
}

function bootstrapEvent(workspaceDir: string) {
  return createInternalHookEvent(
    "agent",
    "bootstrap",
    `agent:${path.basename(workspaceDir)}:api:7:9:1`,
    {
      workspaceDir,
      bootstrapFiles: [
        {
          name: "SOUL.md",
          path: path.join(workspaceDir, "SOUL.md"),
          content: "# generic assistant",
          missing: false,
        },
        {
          name: "MEMORY.md",
          path: path.join(workspaceDir, "MEMORY.md"),
          content: "",
          missing: true,
        },
      ],
    },
  );
}

describe("free-tier persona seed", () => {
  beforeEach(() => {
    clearInternalHooks();
    resetFreeTierPersonaSeedForTest();
  });
  afterEach(() => {
    clearInternalHooks();
    resetFreeTierPersonaSeedForTest();
  });

  it("copies persona files into an org workspace and never MEMORY.md", async () => {
    const { personaRoot, orgDir } = await setup();
    const copied = await copyPersonaIntoOrgWorkspace(personaRoot, orgDir);
    expect([...copied.keys()].sort()).toEqual(Object.keys(PERSONA).sort());
    expect(copied.has("MEMORY.md")).toBe(false);
    expect(await readFile(path.join(orgDir, "SOUL.md"), "utf8")).toBe("# SOUL — NABU AI");
    await expect(readFile(path.join(orgDir, "MEMORY.md"), "utf8")).rejects.toThrow();
  });

  it("patches the current turn's bootstrap set for an org agent", async () => {
    const { orgDir } = await setup();
    registerFreeTierPersonaSeed();
    const event = bootstrapEvent(orgDir);
    await triggerInternalHook(event);
    const soul = (event.context.bootstrapFiles as Array<{ name: string; content: string }>).find(
      (f) => f.name === "SOUL.md",
    );
    expect(soul?.content).toBe("# SOUL — NABU AI");
    expect(await readFile(path.join(orgDir, "AGENTS.md"), "utf8")).toBe("# AGENTS");
  });

  it("leaves the main workspace untouched", async () => {
    const { personaRoot } = await setup();
    registerFreeTierPersonaSeed();
    const event = bootstrapEvent(personaRoot);
    await triggerInternalHook(event);
    const soul = (event.context.bootstrapFiles as Array<{ name: string; content: string }>).find(
      (f) => f.name === "SOUL.md",
    );
    expect(soul?.content).toBe("# generic assistant");
  });

  it("seeds an org workspace only once per process", async () => {
    const { personaRoot, orgDir } = await setup();
    registerFreeTierPersonaSeed();
    await triggerInternalHook(bootstrapEvent(orgDir));
    await writeFile(path.join(personaRoot, "SOUL.md"), "# CHANGED SOURCE");
    await triggerInternalHook(bootstrapEvent(orgDir));
    expect(await readFile(path.join(orgDir, "SOUL.md"), "utf8")).toBe("# SOUL — NABU AI");
  });

  it("is a no-op when the shared root has no persona files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nabu-persona-empty-"));
    const orgDir = path.join(root, "workspace", "agent-org-7");
    await mkdir(orgDir, { recursive: true });
    registerFreeTierPersonaSeed();
    const event = bootstrapEvent(orgDir);
    await triggerInternalHook(event);
    const soul = (event.context.bootstrapFiles as Array<{ name: string; content: string }>).find(
      (f) => f.name === "SOUL.md",
    );
    expect(soul?.content).toBe("# generic assistant");
  });

  it("retries on a later turn when the source persona was missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nabu-persona-retry-"));
    const personaRoot = path.join(root, "workspace");
    const orgDir = path.join(personaRoot, "agent-org-7");
    await mkdir(orgDir, { recursive: true });
    registerFreeTierPersonaSeed();

    const first = bootstrapEvent(orgDir);
    await triggerInternalHook(first);
    const firstSoul = (
      first.context.bootstrapFiles as Array<{ name: string; content: string }>
    ).find((f) => f.name === "SOUL.md");
    expect(firstSoul?.content).toBe("# generic assistant");

    // Source persona appears; the next turn must seed, not stay pinned generic.
    await writeFile(path.join(personaRoot, "SOUL.md"), "# SOUL — NABU AI");
    const second = bootstrapEvent(orgDir);
    await triggerInternalHook(second);
    const secondSoul = (
      second.context.bootstrapFiles as Array<{ name: string; content: string }>
    ).find((f) => f.name === "SOUL.md");
    expect(secondSoul?.content).toBe("# SOUL — NABU AI");
  });
});
