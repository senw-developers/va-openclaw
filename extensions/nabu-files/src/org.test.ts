import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOrgSource } from "./org.js";

describe("resolveOrgSource", () => {
  const KEY = "OPENCLAW_ORGANIZATION_ID";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  it("is dedicated (per-container env org) on a dedicated tenant", () => {
    process.env[KEY] = "7";
    expect(resolveOrgSource("main")).toEqual({ kind: "dedicated", organizationId: "7" });
  });

  it("prefers the env var over a shared-instance agent id", () => {
    process.env[KEY] = "7";
    expect(resolveOrgSource("agent-org-42")).toEqual({ kind: "dedicated", organizationId: "7" });
  });

  it("is shared, deriving the org from agent-org-<orgId>, when env is unset", () => {
    expect(resolveOrgSource("agent-org-42")).toEqual({ kind: "shared", organizationId: "42" });
  });

  it("fails closed for a user agent, main, or unknown shape when env is unset", () => {
    expect(() => resolveOrgSource("agent-user-5")).toThrow(/unresolved/);
    expect(() => resolveOrgSource("main")).toThrow(/unresolved/);
    expect(() => resolveOrgSource(undefined)).toThrow(/unresolved/);
  });

  it("rejects agent-org-0 — 0 is the no-org sentinel", () => {
    expect(() => resolveOrgSource("agent-org-0")).toThrow(/unresolved/);
  });
});
