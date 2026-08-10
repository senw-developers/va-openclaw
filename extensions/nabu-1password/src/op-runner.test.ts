import { describe, expect, it } from "vitest";
import { buildOpArgv, MissingArgError, OperationNotAllowedError } from "./op-runner.js";

describe("buildOpArgv", () => {
  it("builds read argv", () => {
    expect(buildOpArgv("read", { operation: "read", reference: "op://NABU/x/y" })).toEqual([
      "read",
      "--no-newline",
      "op://NABU/x/y",
    ]);
  });

  it("builds item-get argv with vault + fields", () => {
    expect(
      buildOpArgv("item-get", {
        operation: "item-get",
        item: "Stripe",
        vault: "NABU",
        fields: ["username", "password"],
      }),
    ).toEqual([
      "item",
      "get",
      "Stripe",
      "--format=json",
      "--vault",
      "NABU",
      "--fields",
      "username,password",
    ]);
  });

  it("builds item-list argv with and without a vault", () => {
    expect(buildOpArgv("item-list", { operation: "item-list" })).toEqual([
      "item",
      "list",
      "--format=json",
    ]);
    expect(buildOpArgv("item-list", { operation: "item-list", vault: "NABU" })).toEqual([
      "item",
      "list",
      "--format=json",
      "--vault",
      "NABU",
    ]);
  });

  it("builds vault-list argv", () => {
    expect(buildOpArgv("vault-list", { operation: "vault-list" })).toEqual([
      "vault",
      "list",
      "--format=json",
    ]);
  });

  it("rejects operations outside the whitelist", () => {
    expect(() => buildOpArgv("item-delete", { operation: "read" })).toThrow(
      OperationNotAllowedError,
    );
  });

  it("requires a reference for read", () => {
    expect(() => buildOpArgv("read", { operation: "read" })).toThrow(MissingArgError);
  });

  it("rejects a non-op:// reference", () => {
    expect(() => buildOpArgv("read", { operation: "read", reference: "https://evil" })).toThrow(
      MissingArgError,
    );
  });

  it("rejects control characters in values", () => {
    expect(() =>
      buildOpArgv("read", { operation: "read", reference: "op://NABU/x/y\nmalicious" }),
    ).toThrow(MissingArgError);
  });
});
