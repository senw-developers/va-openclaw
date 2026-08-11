import { describe, expect, it } from "vitest";
import { assertOpsToken, mapBrokerError, redactSkillToken } from "./token.js";

describe("mapBrokerError", () => {
  it("maps 401 to a skill-token message", () => {
    expect(mapBrokerError(401, "{}")).toMatch(/plugin credential/i);
  });

  it("maps 404 to an organization-scoped not-configured message", () => {
    const message = mapBrokerError(404, "{}");
    expect(message).toMatch(/not configured for this organization/i);
    expect(message).not.toMatch(/per-user|this user/i);
  });

  it("maps 403 to a not-granted message distinct from not-configured", () => {
    const message = mapBrokerError(403, "{}");
    expect(message).toMatch(/not been granted access/i);
    expect(message).not.toMatch(/not configured/i);
  });

  it("maps 410 to a reconnect prompt", () => {
    expect(mapBrokerError(410, "{}")).toMatch(/revoked/i);
  });

  it("surfaces the backend envelope fields", () => {
    expect(mapBrokerError(410, '{"error":"Re-consent required","reason":"invalid_grant"}')).toMatch(
      /Re-consent required: invalid_grant/,
    );
    expect(mapBrokerError(502, '{"error":"Upstream failed","detail":"timeout"}')).toMatch(
      /Upstream failed: timeout/,
    );
  });

  it("tolerates a non-JSON body", () => {
    expect(mapBrokerError(500, "<html>gateway timeout</html>")).toMatch(
      /1Password broker failed \(500\)\.$/,
    );
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
