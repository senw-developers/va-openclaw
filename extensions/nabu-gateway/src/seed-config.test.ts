import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type OpenClawConfig, resolveDefaultAgentId } from "openclaw/plugin-sdk/health";
import { describe, expect, it } from "vitest";

const SEED_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../nabu-integration/spawn-seed/.openclaw/openclaw.json",
);

function loadSeed(): OpenClawConfig {
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as OpenClawConfig;
}

/**
 * The spawn-seed ships in every provisioned tenant and has no other coverage.
 * Each invariant here has been broken and hand-caught during this port.
 */
describe("spawn-seed openclaw.json", () => {
  it("parses as JSON", () => {
    expect(() => loadSeed()).not.toThrow();
  });

  it("provisions exactly one agent, main, and pins it as the default", () => {
    const seed = loadSeed();
    // Without an explicit default, the first agents.create silently becomes the
    // org default and orphans main's transcripts (createAgentConfigEntry never
    // sets default). The pin is the prerequisite for any seat work.
    expect(seed.agents?.list).toEqual([{ id: "main", default: true }]);
    expect(resolveDefaultAgentId(seed)).toBe("main");
  });

  it("keeps main the default after a seat is added", () => {
    const seed = loadSeed() as { agents: { list: Array<Record<string, unknown>> } };
    seed.agents.list.push({ id: "agent-42", name: "Seat 42", workspace: "/tmp/seat-42" });
    expect(resolveDefaultAgentId(seed as unknown as OpenClawConfig)).toBe("main");
  });

  it("carries every nabu skill token as an env SecretRef, never a literal", () => {
    const entries = (loadSeed() as { plugins?: { entries?: Record<string, { config?: unknown }> } })
      .plugins?.entries;
    for (const id of ["nabu-email", "nabu-1password", "nabu-files", "nabu-google-workspace"]) {
      const token = (entries?.[id]?.config as { apiToken?: unknown } | undefined)?.apiToken;
      expect(token, `${id}.apiToken`).toMatchObject({ source: "env" });
      expect(typeof (token as { id?: unknown }).id, `${id}.apiToken.id`).toBe("string");
    }
  });

  it("routes the org id to Cloudflare only through an env placeholder", () => {
    const header = (
      loadSeed() as {
        models?: { providers?: Record<string, { headers?: Record<string, string> }> };
      }
    ).models?.providers?.["cloudflare-ai-gateway"]?.headers?.["cf-aig-metadata"];
    // Never a baked literal org id — the R-3 doctor check enforces the env var
    // is set at runtime so the placeholder does not ship verbatim.
    expect(header).toContain("${OPENCLAW_ORGANIZATION_ID}");
  });
});
