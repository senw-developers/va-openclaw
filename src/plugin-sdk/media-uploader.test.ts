import { describe, expectTypeOf, it } from "vitest";
import type { MediaResolverInput } from "./media-resolver.js";
import type { MediaUploadInput } from "./media-uploader.js";

// D22 Phase-2 type-level guard. MediaUploadInput / MediaResolverInput no
// longer declare a `channel` field. The @ts-expect-error blocks below are
// the load-bearing fence — if anyone re-adds `channel?: string`, the
// expect-error vanishes and these tests fail loudly.

describe("MediaUploadInput type — channel removed (D22 Phase-2)", () => {
  it("does not declare `channel`", () => {
    expectTypeOf<MediaUploadInput>().not.toHaveProperty("channel");
  });

  it("rejects an object literal with a `channel` field", () => {
    // @ts-expect-error — D22 Phase-2: MediaUploadInput.channel removed.
    const bad: MediaUploadInput = { userId: "42", channel: "telegram" };
    void bad;
  });
});

describe("MediaResolverInput type — channel removed (D22 Phase-2)", () => {
  it("does not declare `channel`", () => {
    expectTypeOf<MediaResolverInput>().not.toHaveProperty("channel");
  });

  it("rejects an object literal with a `channel` field", () => {
    // @ts-expect-error — D22 Phase-2: MediaResolverInput.channel removed.
    const bad: MediaResolverInput = { fileIds: [1], userId: "42", channel: "telegram" };
    void bad;
  });
});
