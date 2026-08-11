import { describe, expect, it } from "vitest";
import { mapBrokerError } from "./token.js";

describe("mapBrokerError", () => {
  it("maps 401 to a skill-token message", () => {
    expect(mapBrokerError(401, "{}")).toMatch(/plugin credential/i);
  });

  it("maps 404 to a per-user not-connected message", () => {
    const message = mapBrokerError(404, "{}");
    expect(message).toMatch(/you have not connected/i);
    expect(message).not.toMatch(/not been granted/i);
  });

  it("maps 403 to an authorization message, distinct from 404", () => {
    const message = mapBrokerError(403, "{}");
    expect(message).toMatch(/not been granted access/i);
    expect(message).not.toMatch(/you have not connected/i);
  });

  it("maps 410 to a revoked-connection message", () => {
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

  it("falls back to a bare status when the body is not JSON", () => {
    expect(mapBrokerError(500, "<html>gateway timeout</html>")).toMatch(
      /Google Workspace broker failed \(500\)\.$/,
    );
  });

  it("reads the files-api style code field too", () => {
    expect(mapBrokerError(500, '{"code":"BROKER_DOWN"}')).toMatch(/BROKER_DOWN/);
  });

  it("caps backend-controlled detail so an unbounded body cannot reach the agent", () => {
    const huge = JSON.stringify({ error: "x".repeat(5000) });
    const message = mapBrokerError(502, huge);
    expect(message.length).toBeLessThan(400);
    expect(message).toContain("xxx");
  });

  it("still surfaces detail from an envelope longer than the old 200-char clamp", () => {
    const body = JSON.stringify({ error: "pad".padEnd(250, "-"), reason: "invalid_grant" });
    expect(mapBrokerError(410, body)).toContain("invalid_grant");
  });
});
