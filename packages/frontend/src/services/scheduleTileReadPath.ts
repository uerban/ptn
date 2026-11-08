import { captureCityData } from "./cityData.ts";
import {
  scheduleTileCoordAt,
  scheduleCellBounds,
  leafForPoint,
  leafSuffixSet,
  TILE_COORD_RE,
  SCHEDULE_TILE_SIZE_LABEL,
} from "@pt/shared/poi";
import {
  getDeparturesFromTile,
} from "@pt/shared/transit";
import type {
  BundleManifest,
  DecodedScheduleTile,
  ServiceState,
} from "@pt/shared/schedule-tile";
import type { Departure, RtTripUpdate } from "@pt/shared";
import { db } from "../db/index.ts";
import { fetchManifest, fetchRtTile, ManifestUnavailableError } from "./api.ts";
import { getDecodedTile, pruneToBundleHash, ensureUnderBudget } from "./scheduleTileCache.ts";
import { isScheduleTileEnabled } from "./scheduleTileFlag.ts";
import { reportTelemetry } from "./errorReporter.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { liveTileOverlayAllowed } from "./departuresPolicy.ts";
import {
  DEFAULT_SCHEDULE_TILE_LIMIT,
  DEFAULT_SCHEDULE_TILE_LIMIT_WITH_LOOKAHEAD,
  DEFAULT_SCHEDULE_TILE_LOOKAHEAD_HOURS,
} from "./scheduleTileConstants.ts";

// R16 — mirror backend defaults (re-exported from the leaf constants module so
// useDepartures can import them statically without pulling the heavy read-path
// graph into the eager Home chunk).
export {
  DEFAULT_SCHEDULE_TILE_LIMIT,
  DEFAULT_SCHEDULE_TILE_LIMIT_WITH_LOOKAHEAD,
  DEFAULT_SCHEDULE_TILE_LOOKAHEAD_HOURS,
  HEDGE_MS,
} from "./scheduleTileConstants.ts";

export type DeparturesForStopResult =
  | { state: "ok"; departures: Departure[]; serviceState: ServiceState }
  | { state: "unavailable" }
  | { state: "stop_not_in_tile" };

/** The cutover seam (R6). Prefers the CANONICAL GTFS coords (`db.gtfsStops`,
 *  builder-identical) so a boundary stop resolves to the same leaf the producer
 *  partitioned it into; falls back to the API stops table (`db.stops`) when the
 *  canonical table has no row. The UI cutover reuses this verbatim (it too only
 *  has a stopId). */
export async function resolveStopLatLon(stopId: string): Promise<{ lat: number; lon: number } | null> {
  const cityId = useCityStore.getState().activeCity.id;
  const data = captureCityData(cityId);
  const g = await data.gtfsStops.get(stopId);
  if (g) return { lat: g.lat, lon: g.lon };
  const s = await db.stops.get(stopId);
  data.assertCurrent();
  if (s?.cityId === cityId && s.location) return { lat: s.location.lat, lon: s.location.lon };
  return null;
}

export interface DeparturesForStopArgs {
  stopId: string;
  now: Date;
  limit?: number;
  lookAheadHours?: number;
}

export interface DeparturesForStopOpts {
  onTileDownloadStart?: () => void;
}

// Retain lightweight manifests by city; never send another city's ETag.
type CachedManifest = { manifest: BundleManifest; etag: string | null; bundleHash: string };
const manifests = new Map<string, CachedManifest>();
const manifestRequests = new Map<string, Promise<CachedManifest>>();
const activeCityId = () => useCityStore.getState().activeCity.id;

async function cityManifest(cityId: string): Promise<CachedManifest> {
  const pending = manifestRequests.get(cityId);
  if (pending) return pending;
  const request = (async () => {
    // fetchManifest captures the current city's URL synchronously.
    if (activeCityId() !== cityId) throw new ManifestUnavailableError();
    const previous = manifests.get(cityId);
    const r = await fetchManifest(previous);
    const entry = { manifest: r.manifest, etag: r.etag, bundleHash: r.bundleHash ?? r.manifest.bundleHash };
    if (previous && previous.bundleHash !== entry.bundleHash) {
      await pruneToBundleHash(entry.bundleHash, previous.bundleHash);
    }
    manifests.delete(cityId);
    manifests.set(cityId, entry);
    if (manifests.size > 8) manifests.delete(manifests.keys().next().value!);
    return entry;
  })();
  manifestRequests.set(cityId, request);
  try { return await request; }
  finally { if (manifestRequests.get(cityId) === request) manifestRequests.delete(cityId); }
}

/** Best-effort refresh for the city selected when the call starts. */
export async function warmManifest(): Promise<void> {
  try { await cityManifest(activeCityId()); } catch { /* best-effort */ }
}

export function currentBundleHash(): string | null {
  return manifests.get(activeCityId())?.bundleHash ?? null;
}

export function currentManifest(): BundleManifest | null {
  return manifests.get(activeCityId())?.manifest ?? null;
}

/** Resolve schedule-tile coords for a lat/lon against a manifest (cell key +
 *  subdivision leaf). Shared by departuresForStop AND the prewarm module so
 *  prewarm warms EXACTLY the tile the popup later fetches.
 *
 *  Returns null when the point lies outside any leaf (R7: never fetch the bare
 *  coord) or when the resolved string fails the coord regex (C5). */
export function resolveTileCoordsForLatLon(manifest: BundleManifest, lat: number, lon: number): string | null {
  const { x, y } = scheduleTileCoordAt(lat, lon);
  const cellKey = `${x}_${y}`;
  const plan = manifest.subdivisions?.[cellKey];
  let tileCoords: string;
  if (plan) {
    const suffix = leafForPoint(scheduleCellBounds(x, y), lat, lon, leafSuffixSet(plan));
    if (suffix === null) return null;
    tileCoords = `${cellKey}-${suffix}`;
  } else {
    tileCoords = cellKey;
  }
  return TILE_COORD_RE.test(tileCoords) ? tileCoords : null;
}

export type ResolveDecodedTileResult =
  | { state: "ok"; tile: DecodedScheduleTile; bundleHash: string; tileCoords: string }
  | { state: "unavailable" }
  | { state: "stop_not_in_tile" };

/**
 * Resolve + decode the schedule tile that owns `stopId` — manifest, cell,
 * subdivision cascade, cached decode — WITHOUT fetching the rt-tile. Shared by
 * `departuresForStop` (which then layers RT on) and the badge-activity prefetch
 * (which is schedule-only). Resolution is purely geographic + bundle-hash
 * addressed, so it takes no `now` — the time window is applied downstream by
 * the caller (`getDeparturesFromTile` / `activeRouteIdsFromTile`).
 *
 * `onTileDownloadStart` fires once on a tile cache MISS (threaded to the cache
 * layer) so a caller's hedge can race the cold download.
 *
 * `sharedManifest` lets a caller resolving MANY stops in one batch (the badge-
 * activity viewport sweep) fetch the manifest ONCE and reuse it for every stop,
 * instead of one `fetchManifest` per stop (which storms the endpoint to a 429).
 * When supplied, the per-call manifest fetch / roll-prune / cache-write is
 * skipped — the caller owns manifest freshness (e.g. via `warmManifest()`).
 */
export async function resolveDecodedTileForStop(
  stopId: string,
  onTileDownloadStart?: () => void,
  sharedManifest?: { manifest: BundleManifest; bundleHash: string },
): Promise<ResolveDecodedTileResult> {
  if (!isScheduleTileEnabled()) return { state: "unavailable" };

  const cityId = activeCityId();
  const coord = await resolveStopLatLon(stopId);
  if (activeCityId() !== cityId) return { state: "unavailable" };
  if (!coord) return { state: "unavailable" };
  const { x, y } = scheduleTileCoordAt(coord.lat, coord.lon);
  const cellKey = `${x}_${y}`;
  const cellBounds = scheduleCellBounds(x, y);

  let manifest: BundleManifest;
  let bundleHash: string;
  if (sharedManifest) {
    // Batch caller supplied a pre-resolved manifest — skip the per-stop fetch.
    manifest = sharedManifest.manifest;
    bundleHash = sharedManifest.bundleHash;
  } else {
    try {
      const r = await cityManifest(cityId);
      if (activeCityId() !== cityId) return { state: "unavailable" };
      manifest = r.manifest;
      bundleHash = r.bundleHash;
    } catch (e) {
      if (e instanceof ManifestUnavailableError) return { state: "unavailable" };
      throw e;
    }
  }

  // Resolve the ONE coord.
  const plan = manifest.subdivisions?.[cellKey];
  let tileCoords: string;
  if (plan) {
    const suffix = leafForPoint(cellBounds, coord.lat, coord.lon, leafSuffixSet(plan));
    if (suffix === null) return { state: "unavailable" }; // R7 — never fetch the bare coord
    tileCoords = `${cellKey}-${suffix}`;
  } else {
    tileCoords = cellKey;
  }
  if (!TILE_COORD_RE.test(tileCoords)) return { state: "unavailable" }; // C5

  // Flag is guaranteed enabled here (early-returned above when off).
  reportTelemetry("schedule_tile_resolve", { stopId, tileCoords, subdivided: plan != null }); // R22

  // Bounded cascade: <= 2 tile fetches + 1 manifest refetch. cellKey is invariant
  // across the cascade (same lat/lon => same cell); only the leaf suffix changes —
  // pass it explicitly so leaf coords are never re-derived by string-splitting
  // `coords` (which corrupts negative-y keys like `2329_-629`).
  const result = await resolveWithCascade(bundleHash, tileCoords, cellKey, cellBounds, coord, false, onTileDownloadStart, cityId);
  if (activeCityId() !== cityId) return { state: "unavailable" };
  if (!result) {
    reportTelemetry("bundle_thrash", { stopId, tileCoords }); // R21
    return { state: "unavailable" };
  }
  const { tile, bundleHash: finalHash, tileCoords: finalCoords } = result;
  if (!tile.stops[stopId]) return { state: "stop_not_in_tile" }; // R8
  return { state: "ok", tile, bundleHash: finalHash, tileCoords: finalCoords };
}

/** The departure window of a read: the backend defaults (R16) where the caller gives none. */
function departureWindow(args: { limit?: number; lookAheadHours?: number }): { lookAheadHours: number; limit: number } {
  return {
    lookAheadHours: args.lookAheadHours ?? DEFAULT_SCHEDULE_TILE_LOOKAHEAD_HOURS,
    limit: args.limit ?? (args.lookAheadHours != null
      ? DEFAULT_SCHEDULE_TILE_LIMIT_WITH_LOOKAHEAD
      : DEFAULT_SCHEDULE_TILE_LIMIT),
  };
}

export async function departuresForStop(
  args: DeparturesForStopArgs,
  opts: DeparturesForStopOpts = {},
): Promise<DeparturesForStopResult> {
  const { lookAheadHours: la, limit: lim } = departureWindow(args);
  const city = useCityStore.getState().activeCity;

  const resolved = await resolveDecodedTileForStop(args.stopId, opts.onTileDownloadStart);
  if (resolved.state !== "ok") return { state: resolved.state };
  const { tile, bundleHash: rtHash, tileCoords: rtCoords } = resolved;

  // Live overlay at the SAME (post-cascade) coords; failure or the schedule-only
  // level => schedule-only (no fallback).
  if (activeCityId() !== city.id) return { state: "unavailable" };
  const realtimeUpdates = await rtTileUpdates(rtHash, rtCoords, args.stopId);
  if (activeCityId() !== city.id) return { state: "unavailable" };

  // K3: tz is read non-reactively from the city store (same pattern as routingStore.ts:148).
  // CityConfig.tz is required (cities.ts:20), so this is always a valid IANA string.
  const tz = city.tz;
  const r = getDeparturesFromTile({ tile, stopId: args.stopId, now: args.now, limit: lim, lookAheadHours: la, realtimeUpdates, tz });
  await ensureUnderBudget();
  return { state: "ok", departures: r.departures, serviceState: r.serviceState };
}

/**
 * How long a fetched rt-tile is reused. The map strip reads its nearest stop
 * and then the stops around it, usually in the same tile, within a second or
 * two; this keeps that to one request. Well under the 30 s live-data poll, so
 * a polling departure sheet still refetches every time.
 */
export const RT_TILE_REUSE_MS = 5_000;

/** A tile's live overlay, keyed as `getDeparturesFromTile` looks trips up; `undefined` = schedule-only. */
type RtOverlay = Map<string, RtTripUpdate> | undefined;

/** A RESOLVED (post-cascade) tile's identity: a 409 cascade may land it on another bundle hash. */
function tileKey(bundleHash: string, tileCoords: string): string {
  return `${bundleHash}/${tileCoords}`;
}

// In flight or settled, keyed by `tileKey`.
const rtTileReuse = new Map<string, { at: number; updates: Promise<RtOverlay> }>();

/**
 * The live overlay of a RESOLVED (post-cascade) tile, keyed the way
 * `getDeparturesFromTile` looks trips up: `tripId|startDate` when the feed
 * scopes the trip to a service day, the bare `tripId` otherwise.
 *
 * Nothing is fetched at the schedule-only real-time level
 * (`realTimePolling: "disabled-schedule-only"`): that level promises no live
 * data, so every tile read (the stop popup, the departure sheet, the map
 * strip) is then the timetable alone. Otherwise a request made for the same
 * tile within `RT_TILE_REUSE_MS` (or still in flight) is reused. Never throws:
 * any non-200 (409 roll/unavailable, network) → `undefined` = schedule-only,
 * with one `rt_tile_unavailable` breadcrumb labelled by `stopId`.
 */
function rtTileUpdates(
  bundleHash: string,
  tileCoords: string,
  stopId: string,
): Promise<RtOverlay> {
  if (!liveTileOverlayAllowed()) return Promise.resolve(undefined);
  const now = Date.now();
  for (const [key, entry] of rtTileReuse) {
    if (now - entry.at >= RT_TILE_REUSE_MS) rtTileReuse.delete(key);
  }
  const key = tileKey(bundleHash, tileCoords);
  const reused = rtTileReuse.get(key);
  if (reused) return reused.updates;
  const updates = fetchRtTileUpdates(bundleHash, tileCoords, stopId);
  rtTileReuse.set(key, { at: now, updates });
  return updates;
}

async function fetchRtTileUpdates(
  bundleHash: string,
  tileCoords: string,
  stopId: string,
): Promise<RtOverlay> {
  // K2: value MUST include tripId — getDeparturesFromTile's realtimeUpdates is ReadonlyMap<string, RtTripUpdate>
  // (RtTripUpdate requires tripId, route-update.ts:24), mirroring the backend snapshot (store.ts:433).
  const rt = await fetchRtTile(bundleHash, SCHEDULE_TILE_SIZE_LABEL, tileCoords);
  if (rt.status === 200 && rt.body) {
    return new Map(rt.body.trips.map((t) => [
      t.startDate ? `${t.tripId}|${t.startDate}` : t.tripId,
      { tripId: t.tripId, delaySeconds: t.delaySeconds, cancelled: t.cancelled },
    ]));
  }
  reportTelemetry("rt_tile_unavailable", { stopId, reason: rt.status === 0 ? "network" : String(rt.status) });
  return undefined;
}

export interface DeparturesForStopsArgs {
  stopIds: string[];
  now?: Date;
  limit?: number;
  lookAheadHours?: number;
  /** Aborted → no further stop is resolved and no further rt-tile fetched. */
  signal?: AbortSignal;
}

/**
 * Departures for SEVERAL stops in one batch — the nearby-directions strip's
 * reverse and extra stops around the user. **Tile-only on purpose:** there is
 * no `departures-for-stop` fallback (`api.getDepartures`), because asking the
 * server about several stops around the user would pinpoint them, while a
 * schedule tile only reveals the cell. The single nearest stop keeps
 * `departuresForStop` (and its policy-gated fallback) through `useDepartures`.
 *
 * Follows the badge-activity batch pattern (`useViewportBadgeActivity`): ONE
 * `warmManifest()` for the whole batch, then a SEQUENTIAL per-stop
 * `resolveDecodedTileForStop` over that shared manifest. The tile cache
 * shares in-flight reads and retains a bounded decoded-tile memo. The rt-tile
 * is fetched once per distinct post-cascade tile (`bundleHash` + `tileCoords`)
 * and reused for every stop in it (none at the schedule-only level, see
 * `rtTileUpdates`).
 *
 * A stop that is unavailable, not in its tile, or whose read throws is simply
 * missing from the result — the others are kept. Never throws; flag off or no
 * manifest → empty map without resolving any stop. An aborted `signal` stops
 * the loop between stops (the caller has moved on); what was read is returned.
 */
export async function departuresForStops(args: DeparturesForStopsArgs): Promise<Map<string, Departure[]>> {
  const out = new Map<string, Departure[]>();
  const stopIds = [...new Set(args.stopIds)];
  if (stopIds.length === 0 || !isScheduleTileEnabled()) return out;
  const now = args.now ?? new Date();
  const { lookAheadHours: la, limit: lim } = departureWindow(args);
  const city = useCityStore.getState().activeCity;
  const aborted = () => args.signal?.aborted === true || activeCityId() !== city.id;

  // Manifest ONCE for the batch; unavailable → no per-stop fetch (no re-storm).
  await warmManifest();
  const manifest = currentManifest();
  const bundleHash = currentBundleHash();
  if (!manifest || !bundleHash || aborted()) return out;
  const shared = { manifest, bundleHash };
  const tz = city.tz; // K3

  // The batch's own overlays, held for the whole batch: sequential cold tile
  // downloads can outlast `RT_TILE_REUSE_MS`, and a batch still makes one
  // rt-tile request per distinct tile, however long it runs.
  const rtByTile = new Map<string, RtOverlay>();
  for (const stopId of stopIds) {
    if (aborted()) break;
    try {
      const resolved = await resolveDecodedTileForStop(stopId, undefined, shared);
      if (resolved.state !== "ok" || aborted()) continue;
      const key = tileKey(resolved.bundleHash, resolved.tileCoords);
      if (!rtByTile.has(key)) {
        rtByTile.set(key, await rtTileUpdates(resolved.bundleHash, resolved.tileCoords, stopId));
      }
      if (aborted()) break;
      const r = getDeparturesFromTile({
        tile: resolved.tile,
        stopId,
        now,
        limit: lim,
        lookAheadHours: la,
        realtimeUpdates: rtByTile.get(key),
        tz,
      });
      out.set(stopId, r.departures);
    } catch { /* one stop's failure never drops the others */ }
  }
  try { await ensureUnderBudget(); } catch { /* best-effort */ }
  return out;
}

export async function resolveWithCascade(
  bundleHash: string,
  tileCoords: string,
  cellKey: string,
  cellBounds: ReturnType<typeof scheduleCellBounds>,
  coord: { lat: number; lon: number },
  manifestSpent: boolean,
  onTileDownloadStart?: () => void,
  cityId: string = activeCityId(),
): Promise<{ tile: DecodedScheduleTile; bundleHash: string; tileCoords: string } | null> {
  let hash = bundleHash;
  let coords = tileCoords;
  let fetches = 0;
  let spent = manifestSpent;
  while (fetches < 2) {
    if (activeCityId() !== cityId) return null;
    const got = await getDecodedTile(hash, SCHEDULE_TILE_SIZE_LABEL, coords, { onTileDownloadStart });
    fetches++;
    if (activeCityId() !== cityId) return null;
    if ("tile" in got) return { tile: got.tile, bundleHash: hash, tileCoords: coords };
    const fr = got.fetchResult;
    if (fr.status === 200) continue; // (defensive; getDecodedTile returns tile on 200)
    if (fr.status === 409 || fr.status === 429) {
      if (fr.status === 429 || spent) return null; // 429 == unavailable; no token left
      spent = true;
      const re = await reResolveViaManifest(coord);
      if (!re) return null;
      hash = re.bundleHash; coords = re.tileCoords; continue;
    }
    if (fr.status === 404 && fr.leaves) {
      // tile_subdivided — consume inlined leaves, token NOT spent.
      const suffix = leafForPoint(cellBounds, coord.lat, coord.lon, new Set(fr.leaves));
      if (suffix === null) return null;
      // Rebuild from the invariant cellKey, NEVER coords.split("-") — a negative-y
      // key (`2329_-629`) would corrupt to `2329_-3` and fail TILE_COORD_RE.
      coords = `${cellKey}-${suffix}`; continue;
    }
    if (fr.status === 404) {
      // tile_not_found on a leaf (stale enumeration) — spend the manifest token once.
      if (spent) return null;
      spent = true;
      const re = await reResolveViaManifest(coord);
      if (!re) return null;
      hash = re.bundleHash; coords = re.tileCoords; continue;
    }
    return null;
  }
  return null;
}

async function reResolveViaManifest(
  coord: { lat: number; lon: number },
): Promise<{ bundleHash: string; tileCoords: string } | null> {
  let manifest: BundleManifest;
  let bundleHash: string;
  try {
    const m = await fetchManifest(); // throws ManifestUnavailableError on 503
    manifest = m.manifest; bundleHash = m.bundleHash ?? m.manifest.bundleHash;
  } catch { return null; }
  const tileCoords = resolveTileCoordsForLatLon(manifest, coord.lat, coord.lon);
  if (tileCoords === null) return null;
  return { bundleHash, tileCoords };
}
