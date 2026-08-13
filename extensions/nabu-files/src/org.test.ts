import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOrganizationId } from "./org.js";

describe("resolveOrganizationId", () => {
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

  it("uses the per-container env var on a dedicated tenant", () => {
    process.env[KEY] = "7";
    expect(resolveOrganizationId("main")).toBe("7");
  });

  it("prefers the env var over a shared-instance agent id", () => {
    process.env[KEY] = "7";
    expect(resolveOrganizationId("agent-org-42")).toBe("7");
  });

  it("derives the org from a shared-instance agent-org-<orgId> when env is unset", () => {
    expect(resolveOrganizationId("agent-org-42")).toBe("42");
  });

  it("fails closed for a user agent, main, or unknown shape when env is unset", () => {
    expect(() => resolveOrganizationId("agent-user-5")).toThrow(/unresolved/);
    expect(() => resolveOrganizationId("main")).toThrow(/unresolved/);
    expect(() => resolveOrganizationId(undefined)).toThrow(/unresolved/);
  });

  it("rejects agent-org-0 — 0 is the no-org sentinel", () => {
    expect(() => resolveOrganizationId("agent-org-0")).toThrow(/unresolved/);
  });
});
