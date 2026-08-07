import { describe, expect, it } from "vitest";
import { assertOpsToken, mapBrokerError, redactSkillToken } from "./token.js";

describe("mapBrokerError", () => {
  it("maps 401 to a skill-token message", () => {
    expect(mapBrokerError(401, "{}")).toMatch(/plugin credential/i);
  });

  it("maps 404 to a per-user message", () => {
    expect(mapBrokerError(404, "{}")).toMatch(/per-user/i);
  });

  it("maps 412 to a connect-1Password prompt", () => {
    expect(mapBrokerError(412, "{}")).toMatch(/connect.*1password/i);
  });

  it("includes the error code on other statuses", () => {
    expect(mapBrokerError(500, '{"code":"BROKER_DOWN"}')).toMatch(/BROKER_DOWN/);
  });
});

describe("assertOpsToken", () => {
  it("accepts an ops_ token", () => {
    expect(() => assertOpsToken("ops_abc123")).not.toThrow();
  });

  it("rejects a non-ops_ token", () => {
    expect(() => assertOpsToken("nope")).toThrow();
    expect(() => assertOpsToken(123)).toThrow();
    expect(() => assertOpsToken(undefined)).toThrow();
  });
});

describe("redactSkillToken", () => {
  it("replaces the token everywhere it appears", () => {
    expect(redactSkillToken("a secret123 b secret123", "secret123")).toBe(
      "a [REDACTED_SKILL_TOKEN] b [REDACTED_SKILL_TOKEN]",
    );
  });

  it("is a no-op when token is empty", () => {
    expect(redactSkillToken("unchanged", "")).toBe("unchanged");
  });
});
