import { describe, it, expect } from "vitest";
import {
  GET_DEPARTURES_FROM_TILE_VERSION,
  SCHEDULE_TILE_WIRE_VERSION,
} from "@pt/shared";
import { computeBundleHash } from "./computeBundleHash.js";

describe("computeBundleHash", () => {
  it("produces a 64-char lowercase hex string", () => {
    const hash = computeBundleHash({
      feedFiles: [{ path: "agency.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    });

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same inputs produce the same hash", () => {
    const inputs = {
      feedFiles: [
        { path: "stops.txt", blobSha256: "b".repeat(64) },
        { path: "agency.txt", blobSha256: "a".repeat(64) },
      ],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: ["https://feed.example/rt.pb"],
    };

    expect(computeBundleHash(inputs)).toBe(computeBundleHash(inputs));
  });

  it("sorts feedFiles by path before hashing (input-order-insensitive)", () => {
    const a = computeBundleHash({
      feedFiles: [
        { path: "agency.txt", blobSha256: "a".repeat(64) },
        { path: "stops.txt", blobSha256: "b".repeat(64) },
      ],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    });
    const b = computeBundleHash({
      feedFiles: [
        { path: "stops.txt", blobSha256: "b".repeat(64) },
        { path: "agency.txt", blobSha256: "a".repeat(64) },
      ],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    });

    expect(a).toBe(b);
  });

  it("changes when any feed-file blob changes", () => {
    const base = computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    });
    const mutated = computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "b".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    });

    expect(base).not.toBe(mutated);
  });

  it("changes when tileSize, minTripsPerRoute, or rtFeedUrls change", () => {
    const base = computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: ["https://feed.example/a"],
    });

    expect(computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 8000, // different
      minTripsPerRoute: 1,
      rtFeedUrls: ["https://feed.example/a"],
    })).not.toBe(base);

    expect(computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 2, // different
      rtFeedUrls: ["https://feed.example/a"],
    })).not.toBe(base);

    expect(computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: ["https://feed.example/b"], // different
    })).not.toBe(base);
  });

  it("changes when GET_DEPARTURES_FROM_TILE_VERSION changes (verified by including it in the input)", () => {
    // We include the version explicitly in `version` for the test;
    // production callers MUST pass `GET_DEPARTURES_FROM_TILE_VERSION`.
    const base = computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
      version: "1",
    });
    const bumped = computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
      version: "2",
    });

    expect(base).not.toBe(bumped);
  });

  it("rtFeedUrls order is significant: [A, B] !== [B, A] (rotation invalidates)", () => {
    // A future regression that sorted `rtFeedUrls` (mirroring the intentional sort on `feedFiles`)
    // would silently make the hash insensitive to rotation, meaning a stale-bundle client would
    // keep serving from a feed that has been deprecated.
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
    };
    const ab = computeBundleHash({
      ...base,
      rtFeedUrls: ["https://feed.example/a", "https://feed.example/b"],
    });
    const ba = computeBundleHash({
      ...base,
      rtFeedUrls: ["https://feed.example/b", "https://feed.example/a"],
    });
    expect(ab).not.toBe(ba);
  });

  it("blobSha256 case is normalised: lowercase and uppercase produce the same hash", () => {
    // Defensive normalisation: some platforms emit uppercase hex digests
    // (e.g. crypto APIs that follow RFC 2202 case). The hash treats them
    // as equivalent so a cross-team integration handing off an uppercase
    // SHA-256 doesn't silently produce a different hash than the same
    // content in lowercase.
    const lower = computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "ab".repeat(32) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    });
    const upper = computeBundleHash({
      feedFiles: [{ path: "stops.txt", blobSha256: "AB".repeat(32) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    });
    expect(lower).toBe(upper);
  });

  it("changes when SCHEDULE_TILE_WIRE_VERSION (wireVersion) changes", () => {
    // Wire-version bumps must auto-invalidate cached bundles. Without this
    // test, a regression that drops `wireVersion` from the canonical input
    // is invisible — clients keep serving v1-format tiles to a v2 decoder.
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    };
    expect(computeBundleHash({ ...base, wireVersion: 1 })).not.toBe(
      computeBundleHash({ ...base, wireVersion: 2 }),
    );
  });

  it("default wireVersion (no override) equals explicitly passing SCHEDULE_TILE_WIRE_VERSION", () => {
    // Pins the production code path: the live `SCHEDULE_TILE_WIRE_VERSION`
    // constant is what the hash actually consumes when callers omit the
    // override. Mirrors the GET_DEPARTURES_FROM_TILE_VERSION pin below.
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    };
    expect(computeBundleHash(base)).toBe(
      computeBundleHash({ ...base, wireVersion: SCHEDULE_TILE_WIRE_VERSION }),
    );
  });

  it("default version (no override) equals explicitly passing GET_DEPARTURES_FROM_TILE_VERSION", () => {
    // Pins the production code path: the live `GET_DEPARTURES_FROM_TILE_VERSION`
    // constant is what the hash actually consumes when callers omit `version`.
    // Without this assertion, renaming or reassigning the exported constant
    // silently changes every production hash while every prior test still
    // passes (they use string literals "1" / "2").
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 12000,
      minTripsPerRoute: 1,
      rtFeedUrls: [],
    };

    expect(computeBundleHash(base)).toBe(
      computeBundleHash({ ...base, version: GET_DEPARTURES_FROM_TILE_VERSION }),
    );
  });

  it("changes when maxCompressedTileBytes (the cap) changes", () => {
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 6000, minTripsPerRoute: 1, rtFeedUrls: [],
      maxCompressedTileBytes: 2_097_152, maxSubdivisionDepth: 4, subdivisionAlgoVersion: "1",
    };
    expect(computeBundleHash({ ...base, maxCompressedTileBytes: 1_500_000 })).not.toBe(computeBundleHash(base));
  });

  it("changes when maxSubdivisionDepth changes", () => {
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 6000, minTripsPerRoute: 1, rtFeedUrls: [],
      maxCompressedTileBytes: 2_097_152, maxSubdivisionDepth: 4, subdivisionAlgoVersion: "1",
    };
    expect(computeBundleHash({ ...base, maxSubdivisionDepth: 5 })).not.toBe(computeBundleHash(base));
  });

  it("changes when subdivisionAlgoVersion changes", () => {
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 6000, minTripsPerRoute: 1, rtFeedUrls: [],
      maxCompressedTileBytes: 2_097_152, maxSubdivisionDepth: 4, subdivisionAlgoVersion: "1",
    };
    expect(computeBundleHash({ ...base, subdivisionAlgoVersion: "2" })).not.toBe(computeBundleHash(base));
  });

  it("identical subdivision knobs → identical hash", () => {
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 6000, minTripsPerRoute: 1, rtFeedUrls: [],
      maxCompressedTileBytes: 2_097_152, maxSubdivisionDepth: 4, subdivisionAlgoVersion: "1",
    };
    expect(computeBundleHash(base)).toBe(computeBundleHash({ ...base }));
  });

  it("the cap default equals the live MAX_COMPRESSED_TILE_BYTES (the literal `?? 2_097_152` must not drift)", async () => {
    // The cap default is a literal in computeBundleHash (no shared→backend dep),
    // so it can silently drift from the real cap. This test imports the live
    // constant from the backend module and asserts that OMITTING the cap hashes
    // the SAME as passing the live cap — i.e. the literal fallback == the real cap.
    const { MAX_COMPRESSED_TILE_BYTES } = await import("../gtfs/scheduleTileBrotli.js");
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 6000, minTripsPerRoute: 1, rtFeedUrls: [],
      maxSubdivisionDepth: 4, subdivisionAlgoVersion: "1",
    };
    expect(computeBundleHash(base)).toBe(
      computeBundleHash({ ...base, maxCompressedTileBytes: MAX_COMPRESSED_TILE_BYTES }),
    );
  });

  it("the maxDepth/algoVersion defaults equal the live shared constants (no literal drift)", async () => {
    const { MAX_SUBDIVISION_DEPTH, SUBDIVISION_ALGO_VERSION } = await import("@pt/shared");
    const base = {
      feedFiles: [{ path: "stops.txt", blobSha256: "a".repeat(64) }],
      tileSize: 6000, minTripsPerRoute: 1, rtFeedUrls: [],
      maxCompressedTileBytes: 2_097_152,
    };
    // Omitting maxDepth/algoVersion hashes the same as passing the live constants.
    expect(computeBundleHash(base)).toBe(
      computeBundleHash({ ...base, maxSubdivisionDepth: MAX_SUBDIVISION_DEPTH, subdivisionAlgoVersion: SUBDIVISION_ALGO_VERSION }),
    );
  });
});
