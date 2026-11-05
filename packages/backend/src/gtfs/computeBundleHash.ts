import { createHash } from "node:crypto";
import {
  GET_DEPARTURES_FROM_TILE_VERSION,
  SCHEDULE_TILE_WIRE_VERSION,
  MAX_SUBDIVISION_DEPTH,
  SUBDIVISION_ALGO_VERSION,
} from "@pt/shared";

/** Single GTFS feed file's identity. */
export interface ComputeBundleHashFeedFile {
  /** Stable path within the feed archive (e.g. `stops.txt`). */
  path: string;
  /** Lowercase hex SHA-256 of the file's bytes. */
  blobSha256: string;
}

/** Inputs to `computeBundleHash`. */
export interface ComputeBundleHashInput {
  /** All feed files in the bundle. Order does not matter; hashed in path-sorted order. */
  feedFiles: readonly ComputeBundleHashFeedFile[];
  /** Cell side length in meters (12000 for the launch grid). */
  tileSize: number;
  /** Min trips/route filter applied at build time. */
  minTripsPerRoute: number;
  /** GTFS-RT feed origin URLs in their feed-source order (rotation invalidates). */
  rtFeedUrls: readonly string[];
  /**
   * Test-only override for the algorithm version tag. Production callers should
   * NOT pass this — the constant `GET_DEPARTURES_FROM_TILE_VERSION` is used by
   * default. Tests vary the version to assert the hash invalidates correctly
   * when the algorithm bumps.
   */
  version?: string;
  /**
   * Test-only override for the wire-format version tag. Production callers
   * should NOT pass this — the constant `SCHEDULE_TILE_WIRE_VERSION` is used
   * by default. Mirrors `version` so tests can assert the hash is sensitive
   * to wire-version bumps without having to mutate the imported constant.
   */
  wireVersion?: number;
  /**
   * Build-time per-tile compressed-byte cap. Production MUST pass the live
   * `MAX_COMPRESSED_TILE_BYTES`. Defaulted to the same value here only so existing
   * tests that omit it keep a stable hash (mirrors the `version`/`wireVersion`
   * override idiom); pinned to the live cap by the drift tests.
   */
  maxCompressedTileBytes?: number;
  /** Max subdivision depth. Defaults to `MAX_SUBDIVISION_DEPTH`; production passes it explicitly. */
  maxSubdivisionDepth?: number;
  /** Subdivision algorithm version. Defaults to `SUBDIVISION_ALGO_VERSION`; production passes it explicitly. */
  subdivisionAlgoVersion?: string;
}

// We deliberately drop it: the algorithm version is captured by GET_DEPARTURES_FROM_TILE_VERSION (a
// single explicit knob), and a separate "yesterday/today/tomorrow" string would silently lie about
// round-4's dynamic 4-day expansion. One algorithm-version tag is the single point of truth — bump
// it when the algorithm changes in a client-visible way.

/** * Canonical input order:
 *   1. For each feed file (sorted ascending by `path`): UTF-8 bytes of `path`,
 *      a NUL byte, lowercase-hex `blobSha256`, a NUL byte.
 *   2. UTF-8 bytes of the build-config knobs joined with NULs:
 *      `tileSize|minTripsPerRoute|version|wireVersion|maxCompressedTileBytes|maxSubdivisionDepth|subdivisionAlgoVersion`.
 *   3. UTF-8 bytes of the RT feed URLs joined with NULs (in input order —
 *      rotation changes the hash).
 *
 * `wireVersion` is included so a wire-schema bump (changing
 * `SCHEDULE_TILE_WIRE_VERSION`) automatically invalidates every cached
 * bundle. Without this, bumping the wire version while keeping the
 * algorithm version unchanged would leave existing bundle hashes valid
 * but their on-disk JSON unreadable by the bumped decoder — silent stale-
 * tile corruption. The two version axes are now coupled at the hash
 * boundary, removing the human-coordinated co-bump requirement.
 *
 * Returns the lowercase hex SHA-256 of the concatenated canonical input.
 */
export function computeBundleHash(input: ComputeBundleHashInput): string {
  const version = input.version ?? GET_DEPARTURES_FROM_TILE_VERSION;
  const wireVersion = input.wireVersion ?? SCHEDULE_TILE_WIRE_VERSION;
  // Cap default stays a literal (no shared→backend dep); pinned to the live cap by
  // the drift tests. maxDepth/algoVersion default from the shared constants.
  const maxCompressedTileBytes = input.maxCompressedTileBytes ?? 2_097_152;
  const maxSubdivisionDepth = input.maxSubdivisionDepth ?? MAX_SUBDIVISION_DEPTH;
  const subdivisionAlgoVersion = input.subdivisionAlgoVersion ?? SUBDIVISION_ALGO_VERSION;
  const hash = createHash("sha256");

  // Section 1: feed files, sorted by path
  const sortedFeedFiles = [...input.feedFiles].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const f of sortedFeedFiles) {
    hash.update(f.path, "utf8");
    hash.update("\0");
    hash.update(f.blobSha256.toLowerCase(), "utf8");
    hash.update("\0");
  }
  // Section boundary marker so a feed file named "12000" can't collide
  // with the tileSize section.
  hash.update("\0\0", "utf8");

  // Section 2: build-config
  hash.update(String(input.tileSize), "utf8");
  hash.update("\0");
  hash.update(String(input.minTripsPerRoute), "utf8");
  hash.update("\0");
  hash.update(version, "utf8");
  hash.update("\0");
  // Use String(wireVersion) so a literal-type constant of `1` becomes
  // the string `"1"`. When SCHEDULE_TILE_WIRE_VERSION is later bumped to
  // `2`, the same expression yields `"2"` and the hash auto-invalidates.
  hash.update(String(wireVersion), "utf8");
  hash.update("\0");
  // Subdivision knobs — LAST Section-2 fields before the terminator (pinned
  // byte position). Any of these changing the on-disk leaf set invalidates the
  // hash. Order is fixed: cap | maxDepth | algoVersion.
  hash.update(String(maxCompressedTileBytes), "utf8");
  hash.update("\0");
  hash.update(String(maxSubdivisionDepth), "utf8");
  hash.update("\0");
  hash.update(subdivisionAlgoVersion, "utf8");
  hash.update("\0\0", "utf8");

  // Section 3: RT feeds, in input order
  for (const url of input.rtFeedUrls) {
    hash.update(url, "utf8");
    hash.update("\0");
  }
  // Trailing section boundary preserves the invariant for any future section 4.
  hash.update("\0\0", "utf8");

  return hash.digest("hex");
}
