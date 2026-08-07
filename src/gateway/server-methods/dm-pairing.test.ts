/**
 * dm.pair.* handler tests: store delegation, param validation, and the wire
 * shapes (pending entries with derived expiresAt, ok/id results).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { approveMock, listMock, rejectMock } = vi.hoisted(() => ({
  approveMock: vi.fn(),
  listMock: vi.fn(),
  rejectMock: vi.fn(),
}));

// Full mock: the real store pulls in the channel-plugin registry chain, which
// handler tests must not load. The TTL constant is part of the wire contract.
vi.mock("../../pairing/pairing-store.js", () => ({
  approveChannelPairingCode: approveMock,
  listChannelPairingRequests: listMock,
  rejectChannelPairingCode: rejectMock,
  PAIRING_PENDING_TTL_MS: 60 * 60 * 1000,
}));

import { dmPairingHandlers } from "./dm-pairing.js";

function createOptions(
  method: string,
  params: Record<string, unknown>,
): GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> } {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      logGateway: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    },
  } as unknown as GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  approveMock.mockReset();
  listMock.mockReset();
  rejectMock.mockReset();
});

describe("dm.pair.list", () => {
  it("maps pending requests to public entries with derived expiresAt", async () => {
    const createdAt = "2026-08-07T10:00:00.000Z";
    listMock.mockResolvedValue([
      {
        id: "12345",
        code: "LP3FHZ45",
        createdAt,
        lastSeenAt: createdAt,
        meta: { firstName: "Ada", accountId: "default" },
      },
    ]);
    const options = createOptions("dm.pair.list", { channel: "Telegram " });

    await dmPairingHandlers["dm.pair.list"]?.(options);

    expect(listMock).toHaveBeenCalledWith("telegram", process.env, undefined);
    expect(options.respond).toHaveBeenCalledWith(true, {
      pending: [
        {
          id: "12345",
          code: "LP3FHZ45",
          channel: "telegram",
          createdAt,
          expiresAt: "2026-08-07T11:00:00.000Z",
          meta: { firstName: "Ada", accountId: "default" },
        },
      ],
    });
  });

  it("forwards accountId and rejects malformed channels", async () => {
    listMock.mockResolvedValue([]);
    const valid = createOptions("dm.pair.list", { channel: "telegram", accountId: "work" });
    await dmPairingHandlers["dm.pair.list"]?.(valid);
    expect(listMock).toHaveBeenCalledWith("telegram", process.env, "work");

    const invalid = createOptions("dm.pair.list", { channel: "../etc" });
    await dmPairingHandlers["dm.pair.list"]?.(invalid);
    const [ok, , error] = invalid.respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ["dm.pair.approve", approveMock],
  ["dm.pair.reject", rejectMock],
] as const)("%s", (method, storeMock) => {
  it("delegates to the store and responds ok/id", async () => {
    storeMock.mockResolvedValue({ id: "67890" });
    const options = createOptions(method, {
      channel: "telegram",
      code: " lp3fhz45 ",
      accountId: "work",
    });

    await dmPairingHandlers[method]?.(options);

    expect(storeMock).toHaveBeenCalledWith({
      channel: "telegram",
      code: "lp3fhz45",
      accountId: "work",
    });
    expect(options.respond).toHaveBeenCalledWith(true, { ok: true, id: "67890" });
  });

  it("responds APPROVAL_NOT_FOUND when the store finds no match", async () => {
    storeMock.mockResolvedValue(null);
    const options = createOptions(method, { channel: "telegram", code: "ZZZZZZZZ" });

    await dmPairingHandlers[method]?.(options);

    const [ok, , error] = options.respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "APPROVAL_NOT_FOUND" });
  });

  it("rejects missing code without calling the store", async () => {
    const options = createOptions(method, { channel: "telegram" });

    await dmPairingHandlers[method]?.(options);

    const [ok, , error] = options.respond.mock.calls[0] ?? [];
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(storeMock).not.toHaveBeenCalled();
  });
});
