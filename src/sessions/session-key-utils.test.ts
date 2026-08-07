import { describe, expect, it } from "vitest";
import { parseSessionOwner } from "./session-key-utils.js";

describe("parseSessionOwner v2 — DM shapes", () => {
  it("4-seg per-peer DM yields {userId}", () => {
    expect(parseSessionOwner("agent:main:direct:user-7")).toEqual({ userId: "user-7" });
  });

  it("5-seg per-channel-peer yields {userId} across channels", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:123456")).toEqual({
      userId: "123456",
    });
    expect(parseSessionOwner("agent:main:whatsapp:direct:15551234567")).toEqual({
      userId: "15551234567",
    });
    expect(parseSessionOwner("agent:main:discord:direct:user123")).toEqual({
      userId: "user123",
    });
  });

  it("6-seg per-account-channel-peer (the D22 regression fix) yields {userId}", () => {
    expect(parseSessionOwner("agent:main:discord:acc-1:direct:peer42")).toEqual({
      userId: "peer42",
    });
  });

  it("6-seg per-account-channel-peer preserves colon-bearing peer suffix", () => {
    expect(parseSessionOwner("agent:main:telegram:acc-1:direct:tg:99:abc")).toEqual({
      userId: "tg:99:abc",
    });
  });

  it("legacy 'dm' alias accepted (parser-side back-compat)", () => {
    expect(parseSessionOwner("agent:main:slack:dm:U123")).toEqual({ userId: "u123" });
  });

  it("peer literally named 'direct' — fail-closed via tail-sentinel scan", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:direct")).toBeNull();
  });
});

describe("parseSessionOwner v2 — HTTP per-user shapes", () => {
  it("HTTP openresponses-user yields {userId}", () => {
    expect(parseSessionOwner("agent:main:openresponses-user:alice")).toEqual({
      userId: "alice",
    });
  });

  it("HTTP openai-user yields {userId}", () => {
    expect(parseSessionOwner("agent:main:openai-user:alice")).toEqual({ userId: "alice" });
  });

  it("HTTP openresponses-user accepts mixed-case (parseAgentSessionKey lowercases)", () => {
    expect(parseSessionOwner("agent:main:openresponses-user:Alice")).toEqual({
      userId: "alice",
    });
  });
});

describe("parseSessionOwner v2 — fail-closed non-owner shapes", () => {
  it("anonymous HTTP openresponses → null", () => {
    expect(parseSessionOwner("agent:main:openresponses:b1c2-uuid")).toBeNull();
  });

  it("anonymous HTTP openai → null", () => {
    expect(parseSessionOwner("agent:main:openai:b1c2-uuid")).toBeNull();
  });

  it("main default → null", () => {
    expect(parseSessionOwner("agent:main:main")).toBeNull();
  });

  it("group keys → null", () => {
    expect(parseSessionOwner("agent:main:telegram:group:g-99")).toBeNull();
  });

  it("channel broadcast keys → null", () => {
    expect(parseSessionOwner("agent:main:discord:channel:c-1")).toBeNull();
  });

  it("cron run keys → null", () => {
    expect(parseSessionOwner("agent:main:cron:job-1:run:run-1")).toBeNull();
  });

  it("bare cron (no agent prefix) → null", () => {
    expect(parseSessionOwner("cron:job-1")).toBeNull();
  });

  it("subagent flat → null", () => {
    expect(parseSessionOwner("agent:main:subagent:worker-1")).toBeNull();
  });

  it("subagent nested → null", () => {
    expect(parseSessionOwner("agent:main:subagent:p:subagent:c")).toBeNull();
  });

  it("acp spawn → null", () => {
    expect(parseSessionOwner("agent:main:acp:u1")).toBeNull();
  });

  it("acp binding → null", () => {
    expect(parseSessionOwner("agent:main:acp:binding:telegram:acc-1:hash")).toBeNull();
  });
});

describe("parseSessionOwner v2 — thread suffix stripping", () => {
  it("single thread suffix → strip then classify base DM", () => {
    expect(parseSessionOwner("agent:main:slack:dm:U1:thread:1699")).toEqual({
      userId: "u1",
    });
  });

  it("double thread suffix → strip iteratively", () => {
    expect(parseSessionOwner("agent:main:slack:dm:U1:thread:t1:thread:t2")).toEqual({
      userId: "u1",
    });
  });

  it("thread-suffixed group still fails closed", () => {
    expect(parseSessionOwner("agent:main:slack:group:G1:thread:t1")).toBeNull();
  });
});

describe("parseSessionOwner v2 — malformed / empty / whitespace input", () => {
  it("empty / whitespace / null / undefined → null", () => {
    expect(parseSessionOwner("")).toBeNull();
    expect(parseSessionOwner("   ")).toBeNull();
    expect(parseSessionOwner(null)).toBeNull();
    expect(parseSessionOwner(undefined)).toBeNull();
  });

  it("legacy non-agent strings → null", () => {
    expect(parseSessionOwner("main")).toBeNull();
  });

  it("malformed split-only colons → null", () => {
    expect(parseSessionOwner("agent::broken")).toBeNull();
  });

  it("agent prefix only → null", () => {
    expect(parseSessionOwner("agent:main")).toBeNull();
  });

  it("empty peerId after marker → null", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:")).toBeNull();
  });
});

describe("parseSessionOwner v2 — verbatim header path (case preservation)", () => {
  it("mixed-case verbatim HTTP key — parseAgentSessionKey lowercases", () => {
    expect(parseSessionOwner("AGENT:Main:Telegram:DM:UserABC")).toEqual({
      userId: "userabc",
    });
  });
});

describe("parseSessionOwner v2 — adversarial tail-sentinel fail-closed", () => {
  it("DM marker beyond position 2 fails closed (4-segment leading prefix)", () => {
    expect(parseSessionOwner("agent:main:slack:acc-1:room-x:direct:u1")).toBeNull();
  });

  it("DM marker followed by 'subagent' sentinel → null", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:U1:subagent:abc")).toBeNull();
  });

  it("DM marker followed by 'acp' sentinel → null", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:U1:acp:hash")).toBeNull();
  });

  it("DM marker followed by 'cron' sentinel → null", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:U1:cron:job:run:r")).toBeNull();
  });

  it("DM marker followed by 'group' sentinel → null", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:U1:group:G1")).toBeNull();
  });

  it("DM marker followed by 'channel' sentinel → null", () => {
    expect(parseSessionOwner("agent:main:telegram:direct:U1:channel:C1")).toBeNull();
  });

  it("bare ':thread:' suffix with no thread id → null (residual 'thread' is a sentinel)", () => {
    expect(parseSessionOwner("agent:main:slack:dm:U1:thread:")).toBeNull();
  });
});
