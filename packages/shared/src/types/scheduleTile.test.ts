import { describe, it, expect } from "vitest";
import { BUNDLE_HASH_HEADER } from "./scheduleTile.js";
import type {
  TileSubdividedBody,
  TileNotFoundBody,
  BundleHashMismatchBody,
  BundleUnavailableBody,
  TileErrorBody,
  Tile409Body,
} from "./scheduleTile.js";

describe("bundle-hash header name", () => {
  // Spelled out rather than compared to the const — asserting a const against
  // itself proves nothing. The SAME literal is pinned on the Rust side
  // (`crates/pt-serve/src/http/adapter.rs`), so a typo in either plane's
  // constant fails that plane's own suite instead of waiting for the live
  // route-parity gate to notice the two planes disagree.
  it("is the wire literal both serving planes emit", () => {
    expect(BUNDLE_HASH_HEADER).toBe("X-PT-Bundle-Hash");
  });
});

describe("schedule-tile error body types", () => {
  it("tile_subdivided body carries leaves[]", () => {
    const b: TileSubdividedBody = { error: "tile_subdivided", leaves: ["0", "3-1"] };
    expect(b.error).toBe("tile_subdivided");
    expect(b.leaves).toEqual(["0", "3-1"]);
  });
  it("tile_not_found body has no leaves", () => {
    const b: TileNotFoundBody = { error: "tile_not_found" };
    expect(b.error).toBe("tile_not_found");
  });
  it("409 union discriminates on error", () => {
    const a: Tile409Body = { error: "bundle_hash_mismatch", currentBundleHash: "x" };
    const c: Tile409Body = { error: "bundle_unavailable" };
    expect(a.error).toBe("bundle_hash_mismatch");
    expect(c.error).toBe("bundle_unavailable");
  });
  it("TileErrorBody union covers both 404 sub-reasons", () => {
    const sub: TileErrorBody = { error: "tile_subdivided", leaves: [] };
    const nf: TileErrorBody = { error: "tile_not_found" };
    expect([sub.error, nf.error]).toEqual(["tile_subdivided", "tile_not_found"]);
  });
});
