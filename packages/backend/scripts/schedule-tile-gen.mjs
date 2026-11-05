#!/usr/bin/env node
// Stage C schedule-tile producer build (backend GTFS-index shed — temporary
// spike-killer). Reads a staged PTB generation dir, reconstructs the backend's
// CanonicalStore (the SAME `loadFromPtb` the boot path uses), runs the EXISTING
// `buildBundle` verbatim, and writes the schedule-tile bundle + manifest into
// `<staging>/schedule-tiles/`. Prints one
//   "schedule-tile-bundle <sha256-of-manifest.json> <bytes> <bundleHash>"
// line to stdout (the Rust producer parses this into generation.json, mirroring
// the color-artifacts-gen.mjs convention).
//
// This is the producer-side sibling of color-artifacts-gen.mjs: it imports
// backend logic from ../dist/ (so the backend must be built) and treats the
// staging dir as `argv[2]`. The build RAM (the redeploy spike) MOVES here — to
// a batch context where a transient peak is acceptable — instead of the serving
// backend's resident index. See
// the schedule tile producer build shed notes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadFromPtb } from "../dist/gtfs/loadFromPtb.js";
import { buildBundle } from "../dist/gtfs/buildBundle.js";
import { writeBundleManifest } from "../dist/gtfs/writeBundleManifest.js";
import { SCHEDULE_TILE_EDGE_METERS } from "@pt/shared";

// Mirror the scheduler's default (scheduler.ts: `minTripsPerRoute ?? 0`); the
// staged generation has no per-route trip floor.
const MIN_TRIPS_PER_ROUTE = 0;

/**
 * Build the RouteResolvers the tile build needs from the producer's
 * `route-styles.json` (the same artifact color-artifacts-gen.mjs already emits:
 * `{ "<routeId>": { color, textColor, subMode } }`, color is 6-hex with NO
 * leading '#'). `resolveRouteColor` must return `#RRGGBB` (buildTileForCell
 * prepends nothing to an override) — so re-add the '#'. A missing route → both
 * resolvers return `undefined`, and buildTileForCell falls back to the GTFS
 * route_color. route-styles.json is read here (not recomputed) so the producer
 * tile colors match exactly what the backend's /stops route serves.
 */
function buildResolvers(stagingDir) {
  const routeStylesPath = join(stagingDir, "route-styles.json");
  if (!existsSync(routeStylesPath)) {
    // route-styles.json is emitted by the color-artifacts step the producer runs
    // earlier in the same publish. A raw ENOENT here would be opaque; spell out
    // the ordering dependency instead.
    throw new Error(
      `route-styles.json not found at ${routeStylesPath}; the color-artifacts step must run first`,
    );
  }
  const routeStyles = JSON.parse(readFileSync(routeStylesPath, "utf8"));
  return {
    resolveRouteColor: (routeId) => {
      const c = routeStyles[routeId]?.color;
      return c ? `#${c}` : undefined;
    },
    resolveRouteSubMode: (routeId) => routeStyles[routeId]?.subMode,
  };
}

/**
 * Write `<dir>/<name>.json` and print the `"<name> <sha256hex> <bytes>"` line
 * the Rust producer parses (the EXACT split_whitespace + is_sha256_hex protocol the
 * schedule-tile-bundle line uses, refresh.rs). `body` is the already-serialized
 * JSON string; the SHA + byte count are over those exact bytes so the producer's
 * step-7 offline-validate re-hash matches.
 */
function emitArtifact(dir, name, body) {
  writeFileSync(join(dir, `${name}.json`), body);
  const sha = createHash("sha256").update(body).digest("hex");
  process.stdout.write(`${name} ${sha} ${Buffer.byteLength(body)}\n`);
}

async function main() {
  const stagingDir = process.argv[2];
  if (!stagingDir) {
    process.stderr.write("usage: schedule-tile-gen.mjs <staging-dir>\n");
    process.exit(2);
  }

  // Tile bundleHash is the publication generationId, distinct from PTB content SHA; the backend serves
  // tiles under this hash and advertises it (bridge pattern). Reading it from
  // generation.json keeps the producer and backend in lockstep with no second
  // hash computation.
  const generation = JSON.parse(readFileSync(join(stagingDir, "generation.json"), "utf8"));
  const bundleHash = generation.generationId;
  if (typeof bundleHash !== "string" || bundleHash.length === 0) {
    process.stderr.write("schedule-tile-gen: generation.json has no generationId\n");
    process.exit(2);
  }

  // Reconstruct the CanonicalStore from the staged PTB — the same loadFromPtb
  // the backend boot path runs (reads bundle.ptb + adjacent bundle.ptb.{meta,
  // shapes}.json sidecars), so the canonical inputs are byte-for-byte the ones
  // buildBundle would have seen in-process.
  const bundlePath = join(stagingDir, "bundle.ptb");
  const loaded = await loadFromPtb(bundlePath, MIN_TRIPS_PER_ROUTE);

  // cityId labels the tile bytes (DecodedScheduleTile.cityId); the PTB
  // carries no slug, so derive it from the env the producer already exports
  // (PT_CITY_ID / CITY_ID). A missing cityId would silently stamp every tile
  // with cityId:"", diverging from what the backend embeds — fail loudly.
  const cityId = process.env.PT_CITY_ID ?? process.env.CITY_ID;
  if (!cityId) {
    process.stderr.write("schedule-tile-gen: PT_CITY_ID or CITY_ID must be set\n");
    process.exit(2);
  }

  const dataDir = join(stagingDir, "schedule-tiles");
  const resolvers = buildResolvers(stagingDir);

  const result = await buildBundle({
    canonical: loaded.canonical,
    bundleHash,
    cityId,
    dataDir,
    resolveRouteColor: resolvers.resolveRouteColor,
    resolveRouteSubMode: resolvers.resolveRouteSubMode,
  });

  // Write the canonical typed manifest.json at the bundle root (what the serve
  // route's getCurrentBundleHash() reads). Same arg shape buildAndPublishBundle
  // passes: dataDir + bundleHash + generatedAt + tileSize + subdivisions.
  writeBundleManifest({
    dataDir,
    bundleHash: result.bundleHash,
    generatedAt: Date.now(),
    tileSize: SCHEDULE_TILE_EDGE_METERS,
    subdivisions: result.subdivisions,
  });

  // Record the manifest's content hash + byte size for the producer (so a corrupt
  // manifest is caught at publish/load via the recorded sha, mirroring the
  // color/shapes artifact hashes).
  const manifestBytes = readFileSync(join(dataDir, "manifest.json"));
  const sha = createHash("sha256").update(manifestBytes).digest("hex");
  process.stdout.write(`schedule-tile-bundle ${sha} ${manifestBytes.length} ${result.bundleHash}\n`);

  // ── C4 B4/B6 producer-artifact sheds ──────────────────────────────────────
  // Written into the staging dir (NOT schedule-tiles/) so they ride the producer's
  // whole-dir rename and the Node backend can load them from the generation
  // root. Both shed a resident GTFS-index read in producer mode:
  //   trip-route.json → B4 RT grouping (replaces canonical.getTrip().routeId)
  //   stop-cell.json  → B6 departures tile pick (replaces getStopLatLon + descent)

  // trip-route.json — interned { routes: string[], trips: {tripId: routeIdx} }.
  // A genuine byproduct of loaded.canonical (no extra GTFS work): route value-
  // space is tiny + hugely repeated, so interning bounds the Paris/IDFM footprint
  // (~473k trips, ≤~2.1k distinct routes). Bare tripId keys only — the consumer
  // skips date-scoped `tripId|YYYYMMDD` RT keys (store.ts), and the canonical
  // trip universe carries no `|`.
  const routeIndex = new Map();
  const routes = [];
  // Null-prototype: a GTFS trip_id is an arbitrary string and may legally be
  // `__proto__` (or another Object.prototype key). On a plain `{}`, `trips[id]=`
  // would hit the prototype accessor instead of creating an own property, so
  // that trip would vanish from trip-route.json → producer-mode RT would drop
  // its updates. (stop-cell uses Object.fromEntries below, which is already safe.)
  const trips = Object.create(null);
  loaded.canonical.iterTrips((tripId, trip) => {
    let idx = routeIndex.get(trip.routeId);
    if (idx === undefined) {
      idx = routes.length;
      routes.push(trip.routeId);
      routeIndex.set(trip.routeId, idx);
    }
    trips[tripId] = idx;
  });
  emitArtifact(stagingDir, "trip-route", JSON.stringify({ routes, trips }));

  // stop-cell.json — { stopId: tileCoords } straight from buildBundle's return.
  // tileCoords is the ACTUAL on-disk `.br` filename the build assigned the stop
  // (bare `${x}_${y}` or `${x}_${y}-${suffix}` for a subdivided cell), single-
  // sourcing the bucketing rather than re-deriving it here. A stop the build
  // could not place in any leaf is omitted from the map (consumer → unavailable).
  const stopCell = Object.fromEntries(result.stopTileCoords);
  emitArtifact(stagingDir, "stop-cell", JSON.stringify(stopCell));
}

main().catch((err) => {
  process.stderr.write(`schedule-tile-gen: ${err?.stack ?? err}\n`);
  process.exit(1);
});
