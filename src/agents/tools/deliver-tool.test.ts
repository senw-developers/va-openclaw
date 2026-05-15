import { mkdtempSync, rmSync, writeFileSync, mkdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeliverTool } from "./deliver-tool.js";

describe("deliver tool", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(path.join(tmpdir(), "deliver-ws-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const run = (args: Record<string, unknown>) => {
    const tool = createDeliverTool({ workspaceDir: ws });
    return tool.execute!("call_1", args);
  };

  it("rejects missing path", async () => {
    await expect(run({})).rejects.toThrow(/path required/i);
  });

  it("delivers a workspace-relative path and resolves it absolute", async () => {
    writeFileSync(path.join(ws, "report.csv"), "a,b\n1,2\n");
    const res = await run({ path: "report.csv" });
    const deliverables = (res.details as { deliverables: Array<Record<string, unknown>> })
      .deliverables;
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0].path).toBe(path.join(ws, "report.csv"));
    expect(deliverables[0].name).toBe("report.csv");
    expect(deliverables[0].sizeBytes).toBe(8);
  });

  it("auto-detects mime from extension, honors override", async () => {
    writeFileSync(path.join(ws, "a.csv"), "x");
    const auto = await run({ path: "a.csv" });
    expect((auto.details as { deliverables: Array<{ mime?: string }> }).deliverables[0].mime).toBe(
      "text/csv",
    );

    writeFileSync(path.join(ws, "b.bin"), "x");
    const override = await run({ path: "b.bin", mime: "application/zip" });
    expect(
      (override.details as { deliverables: Array<{ mime?: string }> }).deliverables[0].mime,
    ).toBe("application/zip");
  });

  it("uses provided name over basename", async () => {
    writeFileSync(path.join(ws, "raw.xlsx"), "x");
    const res = await run({ path: "raw.xlsx", name: "Q3 Report.xlsx" });
    expect((res.details as { deliverables: Array<{ name: string }> }).deliverables[0].name).toBe(
      "Q3 Report.xlsx",
    );
  });

  it("rejects a path outside the workspace", async () => {
    await expect(run({ path: "../../etc/passwd" })).rejects.toThrow(/inside the workspace/i);
  });

  it("rejects a missing file", async () => {
    await expect(run({ path: "nope.pdf" })).rejects.toThrow(/file not found/i);
  });

  it("rejects a directory (not a regular file)", async () => {
    mkdirSync(path.join(ws, "adir"));
    await expect(run({ path: "adir" })).rejects.toThrow(/not a regular file/i);
  });

  it("rejects an oversize file", async () => {
    const big = path.join(ws, "big.zip");
    writeFileSync(big, "");
    truncateSync(big, 100 * 1024 * 1024 + 1); // sparse, cheap
    await expect(run({ path: "big.zip" })).rejects.toThrow(/exceeds the .* delivery limit/i);
  });

  it("does NOT leak the path or a MEDIA: token into LLM-visible content", async () => {
    writeFileSync(path.join(ws, "data.csv"), "hello");
    const res = await run({ path: "data.csv" });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("Delivered data.csv (5 B)");
    expect(text).not.toContain("MEDIA:");
    expect(text).not.toContain(ws);
    expect(text).not.toMatch(/https?:\/\//);
  });
});
