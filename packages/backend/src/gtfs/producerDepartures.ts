import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEDULE_TILE_SIZE_LABEL,
  decodeScheduleTile,
  getDeparturesFromTile,
  TILE_COORD_RE,
  type Departure,
  type RtTripUpdate,
} from "@pt/shared";
import { decompressTileBytes } from "./scheduleTileBrotli.js";
import type { ProducerScheduleTileSource } from "./producerScheduleTiles.js";

/**
 * Producer-mode departures source — reads departures out of the producer-built
 * generation dir instead of building an ephemeral in-memory tile off the routing
 * `CanonicalStore` (`buildEphemeralTileForStop`).
 *
 * **NO PRODUCTION CONSUMER since 2026-08-10.** Its only caller was the legacy
 * `/api/departures` shim, deleted with the legacy-departures retirement.
 * It is kept deliberately, not
 * by oversight: `producerArtifactDifferential.test.ts` uses it as the probe in
 * the only check that `stop-cell.json` maps a stop to the tile it actually lives
 * in, and the producer still emits that artifact. Delete this module and a
 * shipped artifact goes unverified. If `stop-cell.json` ever stops being
 * emitted, this goes with it.
 *
 * It was the LAST `CanonicalStore` consumer in the departure path — with B6,
 * producer mode read NO `CanonicalStore` for departures at all, neither for
 * departure data NOR for cell geography, the index-shed prerequisite for
 * Plan-C4.
 *
 * How a stop maps to its on-disk tile:
 *   1. The injected `tileCoordsForStop(stopId)` (the producer-built
 *      `stop-cell.json` artifact) returns the EXACT on-disk `.br` filename stem
 *      the build assigned that stop's departures — bare `${x}_${y}`, or
 *      `${x}_${y}-${suffix}` for a subdivided cell. The build single-sources this
 *      assignment (the same loop that names the `.br` file), so there is no
 *      lat/lon→cell re-derivation here and no `canonical.getStop` read. An
 *      unknown/unmapped stop ⇒ `unavailable`.
 *   2. Read `<genDir>/<bundleHash>/<tileSize>/<coords>.br`, decode, and run
 *      `getDeparturesFromTile`.
 *
 * The `existsSync(tilePath)→unavailable` guard is RETAINED: a stop whose tile
 * failed to build stays absent on disk even if `stop-cell.json` maps it.
 *
 * Generation-roll safety (PR #337 / ST3): the gen dir + bundle hash + manifest
 * snapshot are RE-RESOLVED per call (the `ProducerScheduleTileSource` re-keys on
 * `generationId`), so a generation roll re-points cleanly with no boot-time
 * freeze. The injected `tileCoordsForStop` (the `producerArtifacts` loader)
 * re-keys on the same `generationId`, so the coord and the tiles come from one
 * generation snapshot.
 */
export interface ProducerDeparturesSourceDeps {
  /** Re-resolves the producer gen dir / hash / manifest snapshot per call. */
  tileSource: Pick<
    ProducerScheduleTileSource,
    "resolveDataDir" | "getCurrentBundleHash" | "getManifestSnapshot"
  >;
  /**
   * Resolve a stop's on-disk tile coords (the `.br` filename stem) from the
   * producer-built `stop-cell.json` artifact — bare `${x}_${y}` or
   * `${x}_${y}-${suffix}`. `undefined` ⇒ unknown/unmapped stop ⇒ `unavailable`.
   * Single-sources the cell assignment from the build; no `canonical.getStop`.
   */
  tileCoordsForStop: (stopId: string) => string | undefined;
  /**
   * Optional logger (fastify pino `log.warn(obj, msg)`). Receives a `warn` only
   * when a tile read/decode fails for a non-ENOENT reason (corrupt/partial tile
   * or brotli failure). A transient ENOENT (TOCTOU vs the bundle janitor) stays
   * quiet — it's the expected race, not a corruption signal.
   */
  log?: { warn: (obj: object, msg: string) => void };
  /**
 * Observability hook (I-3). Fired once per `getDepartures` call: `"served"` when the
 * `stop-cell.json` artifact located a real on-disk tile and departures were produced;
 * `"fallback"` whenever the producer path returns `unavailable` and the route falls through to
 * the legacy `canonical` path — including the persistently-absent-artifact / unknown-stop
 * (ENOENT-class) case, which stays `warn`-quiet but MUST still be counted. `index.ts` wires
 * this to `metricsRegistry.producerArtifactServedTotal{artifact:"stop_cell"}`.
 */
  onArtifactResult?: (result: "served" | "fallback") => void;
}

export interface ProducerDeparturesArgs {
  stopId: string;
  /** Wall-clock reference time (the `time` query param or `now`). */
  now: Date;
  /** Maximum departures to return after sorting by scheduled time. */
  limit: number;
  /** Window upper bound at `now + lookAheadHours`. */
  lookAheadHours: number;
  /** Node-merged RT overlay (delays/cancellations), same as the rt-tile route. */
  realtimeUpdates?: ReadonlyMap<string, RtTripUpdate>;
}

export type ProducerDeparturesResult =
  | { state: "ok"; departures: Departure[] }
  /** The producer source can't be resolved (cold start / mid-publish / missing
   *  tile / unknown stop). The caller falls through to the legacy path. */
  | { state: "unavailable" };

export interface ProducerDeparturesSource {
  getDepartures(args: ProducerDeparturesArgs): ProducerDeparturesResult;
}

export function createProducerDeparturesSource(
  deps: ProducerDeparturesSourceDeps,
): ProducerDeparturesSource {
  const { tileSource, tileCoordsForStop, log, onArtifactResult } = deps;

  function getDepartures(args: ProducerDeparturesArgs): ProducerDeparturesResult {
    // Count every producer-path outcome (I-3): `served` when the `stop-cell.json` artifact located
    // a real tile, `fallback` on any `unavailable` (the caller falls through to `canonical`) —
    // including the persistently-absent / unknown-stop ENOENT case (counted, but log-quiet).
    const unavailable = (): ProducerDeparturesResult => {
      onArtifactResult?.("fallback");
      return { state: "unavailable" };
    };

    // The producer build single-sourced this stop→tile assignment into
    // `stop-cell.json`; we read the EXACT on-disk `.br` filename stem here
    // instead of re-deriving it from lat/lon. No `canonical.getStop`.
    const tileCoords = tileCoordsForStop(args.stopId);
    if (!tileCoords || !TILE_COORD_RE.test(tileCoords)) return unavailable();

    // Re-resolve the gen dir + hash + manifest snapshot together (the snapshot
    // re-resolves the same generation), so a mid-call roll can't tear the dir
    // from the hash the tile coords were assigned against.
    const dataDir = tileSource.resolveDataDir();
    const snapshot = tileSource.getManifestSnapshot();
    const bundleHash = snapshot?.bundleHash ?? tileSource.getCurrentBundleHash();
    if (!dataDir || !bundleHash) return unavailable();

    const tilePath = join(dataDir, bundleHash, SCHEDULE_TILE_SIZE_LABEL, `${tileCoords}.br`);
    if (!existsSync(tilePath)) return unavailable();

    let tile;
    try {
      tile = decodeScheduleTile(decompressTileBytes(readFileSync(tilePath)));
    } catch (err) {
      // TOCTOU vs. the bundle janitor (transient ENOENT) or a corrupt/partial
      // tile. Degrade to "unavailable" — the caller falls through to the legacy
      // path rather than 500-ing on a transient read. A non-ENOENT failure
      // (brotli error / decode error / corrupt tile) is abnormal — warn-log it;
      // a bare ENOENT is the expected janitor race, so stay quiet.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log?.warn?.({ tilePath, err }, "producer departures: schedule tile unreadable/undecodable");
      }
      return unavailable();
    }

    const { departures } = getDeparturesFromTile({
      tile,
      stopId: args.stopId,
      now: args.now,
      limit: args.limit,
      lookAheadHours: args.lookAheadHours,
      realtimeUpdates: args.realtimeUpdates,
    });
    onArtifactResult?.("served");
    return { state: "ok", departures };
  }

  return { getDepartures };
}
