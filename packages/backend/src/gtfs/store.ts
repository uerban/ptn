import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LRUCache } from "lru-cache";
import type { Departure, TransportMode, RoutingBundleShape, ColorConfig, RtTripUpdate, LabelAnchor } from "@pt/shared";
import { DEP_SECS_NOT_SERVED, getDeparturesFromTile } from "@pt/shared";
import type { GtfsIndexes, RoutingBuildInput } from "./index-builder.js";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import { buildEphemeralTileForStop } from "./buildEphemeralTileForStop.js";
import { buildMapView, type MapView } from "./views/MapView.js";
import { buildRoutingView, type RoutingView } from "./views/RoutingView.js";
import type { TransfersStore } from "./transfersStore.js";
import type { RouteResolvers } from "./routeResolvers.js";

// ── Public types ────────────────────────────────────────────────────────────

export interface StopWithRoutes {
  id: string;
  name: string;
  location: { lat: number; lon: number };
  routes: {
    id: string;
    shortName: string;
    color: string;
    textColor: string;
    mode: TransportMode;
    subMode?: string;
  }[];
  /** Precomputed label anchor from the solver; absent ⇒ renderer default. */
  labelAnchor?: LabelAnchor;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DAY_FIELDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Valid `LabelAnchor` values — mirrors the union in `@pt/shared`'s store.ts. */
const LABEL_ANCHOR_VALUES = new Set<LabelAnchor>([
  "right",
  "top-right",
  "top",
  "top-left",
  "left",
  "bottom-left",
  "bottom",
  "bottom-right",
]);

const PALETTE_KEYS = [
  "universal",
  "deuteranopia",
  "protanopia",
  "tritanopia",
  "highContrast",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === "string");
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.values(v).every((entry) => typeof entry === "string");
}

function isSubModeEntry(v: unknown): v is ColorConfig["modes"][number] {
  return isPlainObject(v) &&
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    (v.labelMode === undefined || typeof v.labelMode === "string") &&
    (v.labelColor === undefined || typeof v.labelColor === "string") &&
    typeof v.parentMode === "string" &&
    typeof v.color === "string" &&
    typeof v.routeCount === "number" &&
    Number.isFinite(v.routeCount) &&
    isStringArray(v.sampleRoutes);
}

function isThemePalettes(v: unknown): v is ColorConfig["palettes"]["light"] {
  return isPlainObject(v) && PALETTE_KEYS.every((key) => isStringMap(v[key]));
}

function isColorConfigArtifact(v: unknown): v is ColorConfig {
  return isPlainObject(v) &&
    Array.isArray(v.modes) &&
    v.modes.every(isSubModeEntry) &&
    isPlainObject(v.palettes) &&
    isThemePalettes(v.palettes.light) &&
    isThemePalettes(v.palettes.dark) &&
    typeof v.universalLimited === "boolean";
}

type RouteStyleArtifact = Record<string, { color: string; textColor: string; subMode: string }>;

function isRouteStyle(v: unknown): v is RouteStyleArtifact[string] {
  return isPlainObject(v) &&
    typeof v.color === "string" &&
    typeof v.textColor === "string" &&
    typeof v.subMode === "string";
}

function isRouteStylesArtifact(v: unknown): v is RouteStyleArtifact {
  return isPlainObject(v) && Object.values(v).every(isRouteStyle);
}

function isLabelAnchorMap(v: unknown): v is Record<string, LabelAnchor> {
  return isPlainObject(v) &&
    Object.values(v).every((entry) =>
      typeof entry === "string" && LABEL_ANCHOR_VALUES.has(entry as LabelAnchor)
    );
}

/**
 * Approximate haversine-like distance between two lat/lon points in meters.
 * Uses the equirectangular approximation which is accurate enough for short
 * distances (< 100 km).
 */
function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const avgLat = ((lat1 + lat2) / 2) * toRad;
  const dx = (lon2 - lon1) * toRad * Math.cos(avgLat) * 6_371_000;
  const dy = (lat2 - lat1) * toRad * 6_371_000;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Format a Date as YYYYMMDD in local time (for GTFS date comparison).
 */
function formatDateYYYYMMDD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function contrastTextColor(hex: string): string {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length < 6) return "#ffffff";
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.179 ? "#000000" : "#ffffff";
}

// ── Store ───────────────────────────────────────────────────────────────────

export class GtfsStore {
  private indexes!: GtfsIndexes | null;
  private lastUpdated!: Date | null;
  private realtimeUpdates: Map<
    string,
    { delaySeconds: number; cancelled: boolean }
  > = new Map();
  // Parallel map tracking which generation each RT entry was written at.
  // Entries from a previous generation are treated as invisible so reads
  // never see stale RT data after a GTFS swap. We do NOT clear realtimeUpdates
  // on swap; clearing would create a ~30-second blank window while the next RT
  // poll hasn't arrived yet. Tagging-and-filtering avoids that hazard.
  private realtimeGenerations: Map<string, number> = new Map();
  // tripId → its store keys (the bare `tripId` and any `${tripId}|${YYYYMMDD}`).
  // Rebuilt wholesale in setRealtimeUpdates alongside the realtimeUpdates
  // replacement so rtEntriesForTrip is O(keys-for-trip), not O(map).
  private realtimeTripKeys: Map<string, string[]> = new Map();
  private realtimeGeneration = 0;
  // Byte-bounded LRU keyed by `${YYYYMMDD}_${hour}_${5-min-bucket}_${lookaheadHours}`.
  // Replaces the previous single-slot cache (gated by CACHE_TTL_MS=5min and
  // CACHE_MAX_STOPS=10_000). The stop-count gate was the bug — large cities
  // (e.g. Paris with ~20k stops) bypassed the cache entirely. The LRU manages
  // eviction by byte budget instead, so any city fits.
  // Cleared in `swap()` because `swap()` replaces the underlying GTFS data,
  // making any cached active-routes Map stale.
  private activeRoutesCache = new LRUCache<string, Map<string, Set<string>>>({
    maxSize: 128 * 1024 * 1024, // 128 MB per GtfsStore instance
    sizeCalculation: (value, key) => {
      // Conservative byte over-estimate. V8 stores ASCII strings 1-byte
      // internally, so multiplying by 2 here treats keys/values as if they
      // were utf-16 throughout — the LRU evicts more aggressively than
      // strictly necessary, which is the safer side.
      //
      // Wrapped in try/catch because lru-cache silently treats a thrown
      // sizeCalculation as size=1, which would defeat the byte budget for
      // every entry in the malformed-data class (e.g. a Set holding
      // undefined where TS guaranteed string). Pessimistic 128 KB fallback
      // ensures budget enforcement continues; the log surfaces the bug so
      // an operator can investigate.
      try {
        let bytes = 0;
        for (const [k, set] of value) {
          bytes += k.length * 2;
          for (const v of set) bytes += v.length * 2;
        }
        return bytes || 1; // lru-cache v11 throws if sizeCalculation returns 0 when maxSize is set
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[gtfs] activeRoutesCache sizeCalculation failed for key ${key}:`,
          err,
        );
        return 128 * 1024; // 128 KB pessimistic — entry stays cacheable but evicts at reasonable speed
      }
    },
  });
  private allStopsCache: StopWithRoutes[] | null = null;

  private static readonly SPATIAL_CELL_DEG = 0.005; // ~500m
  private colorConfig: ColorConfig | null = null;
  private routeSubModeMap = new Map<string, string>();
  private subModeById = new Map<string, { color: string }>();
  private spatialGrid = new Map<string, string[]>();
  /** stopId → precomputed map-label anchor; rebuilt each `swap()`. */
  private labelAnchors = new Map<string, LabelAnchor>();
  private routeStopIndex: Map<string, Map<string, number>> = new Map();
  /**
 * Reverse index built in `swap()`: tripId → coordinates of the trip's first stop (lowest
 * departureSecs across all CompactStopTimes for that trip). Used by the RT-tile route to
 * determine ownership.
 */
  private _tripFirstStopLocation: Map<string, { lat: number; lon: number }> = new Map();
  // Bumped on each `swap()`. External cache layers (e.g. `gtfs-export.ts`)
  // capture this value at write time and compare it on read; mismatch
  // means the underlying GTFS data was replaced and the cache is stale.
  //
  // INVARIANT: this counter must bump on every code path that mutates
  // `this.indexes` / `this._canonical` / `this._routingView` /
  // `this._mapView`. Today `swap()` is the only such path; future code
  // that introduces another mutation entry point MUST bump `generation`
  // or external caches will silently re-serve stale data with no etag
  // mismatch (clients holding `If-None-Match` would 304 indefinitely).
  private generation = 0;

  getGeneration(): number {
    return this.generation;
  }
  // Set in swap() alongside this.indexes; non-null iff this.indexes is non-null.
  // The `this._canonical!.*` extraction sites in this file are gated by either
  // the `if (!this.indexes) return …` guard or, in `getActiveRoutesByStop`,
  // the `if (!this._mapView || !this._routingView) return result` guard.
  private _canonical: CanonicalStore | undefined;
  private _mapView: MapView | undefined;
  private _routingView: RoutingView | undefined;
  private _minTripsPerRoute = 0;
  private _shapes: RoutingBundleShape[] = [];
  private _shapesBody = "";
  private _shapesHash = "";
  private _transfersStore: TransfersStore | null = null;

  constructor(indexes?: GtfsIndexes, canonical?: CanonicalStore, routingInput?: RoutingBuildInput, minTripsPerRoute = 0) {
    if (indexes && canonical && routingInput) {
      this.swap(indexes, canonical, routingInput, minTripsPerRoute);
    } else {
      this.indexes = null;
      this.lastUpdated = null;
    }
  }

  /**
   * Read a producer-published color artifact from the generation directory.
   * Mirrors crates/pt-serve/src/app/stops.rs's parse_route_styles /
   * parse_label_anchors: missing or malformed → the caller's empty/absent
   * default, never throws. This is not a new failure mode — it's the same
   * 503 / no-labelAnchor degraded state routes/colorConfig.ts, pt-serve's
   * color_config.rs, and the frontend's colorConfigStore.ts already treat
   * as first-class (see design doc for the full citation list).
   */
  private readArtifactJson<T>(generationDir: string, filename: string): T | undefined {
    const filePath = join(generationDir, filename);
    try {
      const raw = readFileSync(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      // ENOENT (producer hasn't published this generation's artifact yet) and
      // JSON.parse SyntaxErrors (malformed content) are both expected/quiet —
      // Node fs errors carry a string `.code`; a SyntaxError from JSON.parse
      // does not, so its absence is how we tell "parse failure" from "fs
      // failure" here. Any OTHER fs error code (EACCES, EISDIR, …) is
      // abnormal — e.g. a misconfigured permission on generationDir — and
      // must not silently look identical to "producer hasn't published yet".
      // Mirrors producerScheduleTiles.ts's `err.code !== "ENOENT"` convention.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== undefined && code !== "ENOENT") {
        console.warn(`[gtfs] unexpected error reading ${filePath}:`, err);
      }
      return undefined;
    }
  }

  /**
   * Populate `colorConfig`/`routeSubModeMap`/`subModeById` for this swap.
   *
   * Producer mode (`generationDir` set): read the producer-published
   * `color-config.json` / `route-styles.json` off disk instead of
   * recomputing — the producer's Rust pipeline already ran clustering +
   * palette generation for this generation (see
   * the color artifacts rust native notes).
   *
   * No producer generation (`generationDir` undefined — `ptb_fallback` /
   * `gtfs-network` deployments): colors stay permanently absent. Not an
   * error: matches the already-first-class-supported "color config absent"
   * state (routes/colorConfig.ts 503, pt-serve's byte-identical 503, the
   * frontend's colorConfigStore.ts graceful fallback).
   *
   * Runs SYNCHRONOUSLY inside `swap()` — this used to be deferred via
   * `setImmediate` because it did CPU-bound clustering work; now it's a
   * cheap `readFileSync` of a small JSON file, so there's no more reason to
   * defer it.
   */
  private computeColorConfig(generationDir?: string): void {
    if (!generationDir) {
      this.colorConfig = null;
      this.routeSubModeMap = new Map();
      this.subModeById = new Map();
      this.allStopsCache = null;
      return;
    }

    const colorConfig = this.readArtifactJson<unknown>(generationDir, "color-config.json");
    const routeStyles = this.readArtifactJson<unknown>(generationDir, "route-styles.json");

    // `readArtifactJson` already returns `undefined` for "file missing" and
    // "malformed JSON syntax". It CANNOT catch "valid JSON, wrong shape"
    // (e.g. `color-config.json` containing `{}` — syntactically fine JSON,
    // but `.modes` is undefined, or `{"modes":[null]}` — a well-formed array
    // containing a malformed element) — that only surfaces once the fields
    // below are accessed, and `colorConfig.modes.map(...)` / `Object.entries(routeStyles)`
    // would throw straight out of `swap()` for such input. Guard the shape,
    // including every element/value, explicitly here so any content short of
    // "the field we need, with the type we need" falls through to the exact
    // same empty-state as a missing file, instead of throwing. `palettes` is
    // never read in this function, but it's stored verbatim into
    // `this.colorConfig` and served as-is to the frontend, which does
    // `colorConfig.palettes[theme]` unguarded — a missing/non-object
    // `palettes` doesn't throw here, it throws in the BROWSER. Guard it here
    // too so a malformed artifact never reaches a client.
    if (
      !isColorConfigArtifact(colorConfig) ||
      !isRouteStylesArtifact(routeStyles)
    ) {
      console.error(
        "[gtfs] color-config.json/route-styles.json missing or malformed in producer generation dir — endpoints will fall back to raw GTFS colors",
      );
      this.colorConfig = null;
      this.routeSubModeMap = new Map();
      this.subModeById = new Map();
      this.allStopsCache = null;
      return;
    }

    this.colorConfig = colorConfig;
    this.subModeById = new Map(colorConfig.modes.map((sm) => [sm.id, { color: sm.color }]));
    this.routeSubModeMap = new Map(Object.entries(routeStyles).map(([routeId, style]) => [routeId, style.subMode]));
    this.allStopsCache = null;

    console.log(`[gtfs] Color config read from ${generationDir}: ${colorConfig.modes.length} sub-modes, universalLimited=${colorConfig.universalLimited}`);
  }

  private getActiveServiceIdsForDate(date: Date): Set<string> {
    if (!this.indexes) return new Set();
    const canonical = this._canonical!;
    const dayOfWeek = date.getDay();
    const dateStr = formatDateYYYYMMDD(date);
    const dayField = DAY_FIELDS[dayOfWeek];

    const result = new Set<string>();
    canonical.iterServices((serviceId, service) => {
      const exception = service.exceptions.get(dateStr);
      if (exception === 1) { result.add(serviceId); return; }
      if (exception === 2) return;
      if (
        service.startDate && service.endDate &&
        dateStr >= service.startDate && dateStr <= service.endDate &&
        service[dayField]
      ) {
        result.add(serviceId);
      }
    });
    return result;
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  getAllStops(): StopWithRoutes[] {
    if (this.allStopsCache) return this.allStopsCache;
    if (!this.indexes) return [];
    const canonical = this._canonical!;

    const result: StopWithRoutes[] = [];

    canonical.iterStops((_stopId, stop) => {
      const routeIds = this._mapView?.getActiveRoutesForStop(stop.id) ?? [];
      const routes: StopWithRoutes["routes"] = [];

      if (routeIds.length > 0) {
        for (const routeId of routeIds) {
          const route = canonical.getRoute(routeId);
          if (route) {
            const sm = this.routeSubModeMap.get(route.id);
            const entry = this.subModeById.get(sm ?? "");
            const normalizedColor = entry?.color ?? (route.color ? `#${route.color}` : "");
            routes.push({
              id: route.id,
              shortName: route.shortName,
              color: normalizedColor.replace(/^#/, ""),
              textColor: contrastTextColor(normalizedColor) === "#000000" ? "000000" : "FFFFFF",
              mode: route.mode,
              subMode: sm ?? route.mode,
            });
          }
        }
      }

      Object.freeze(routes);
      result.push(Object.freeze({
        id: stop.id,
        name: stop.name,
        location: Object.freeze({ lat: stop.lat, lon: stop.lon }),
        routes,
        labelAnchor: this.labelAnchors.get(stop.id),
      }));
    });

    Object.freeze(result);
    this.allStopsCache = result;
    return result;
  }

  getNearbyStops(lat: number, lon: number, radiusMeters: number): StopWithRoutes[] {
    if (!this.indexes) return [];
    const canonical = this._canonical!;

    const cell = GtfsStore.SPATIAL_CELL_DEG;
    const radiusLatDeg = radiusMeters / 111_320;
    const cosLat = Math.max(Math.cos(lat * Math.PI / 180), 0.01);
    const radiusLonDeg = radiusMeters / (111_320 * cosLat);
    const minCellLat = Math.floor((lat - radiusLatDeg) / cell);
    const maxCellLat = Math.floor((lat + radiusLatDeg) / cell);
    const minCellLon = Math.floor((lon - radiusLonDeg) / cell);
    const maxCellLon = Math.floor((lon + radiusLonDeg) / cell);

    const result: StopWithRoutes[] = [];
    for (let cy = minCellLat; cy <= maxCellLat; cy++) {
      for (let cx = minCellLon; cx <= maxCellLon; cx++) {
        const bucket = this.spatialGrid.get(`${cy}_${cx}`);
        if (!bucket) continue;
        for (const stopId of bucket) {
          const stop = canonical.getStop(stopId);
          if (!stop) continue;
          if (distanceMeters(lat, lon, stop.lat, stop.lon) > radiusMeters) continue;

          const routeIds = this._mapView?.getActiveRoutesForStop(stopId) ?? [];
          const routes: StopWithRoutes["routes"] = [];
          if (routeIds.length > 0) {
            for (const routeId of routeIds) {
              const route = canonical.getRoute(routeId);
              if (route) {
                const sm = this.routeSubModeMap.get(route.id);
                const entry = this.subModeById.get(sm ?? "");
                const normalizedColor = entry?.color ?? (route.color ? `#${route.color}` : "");
                routes.push({
                  id: route.id,
                  shortName: route.shortName,
                  color: normalizedColor.replace(/^#/, ""),
                  textColor: contrastTextColor(normalizedColor) === "#000000" ? "000000" : "FFFFFF",
                  mode: route.mode,
                  subMode: sm ?? route.mode,
                });
              }
            }
          }
          result.push({
            id: stop.id,
            name: stop.name,
            location: { lat: stop.lat, lon: stop.lon },
            routes,
            labelAnchor: this.labelAnchors.get(stopId),
          });
        }
      }
    }
    return result;
  }

  getDepartures(stopId: string, date: Date, limit: number, lookAheadHours?: number): Departure[] {
    if (!this.indexes) return [];
    const canonical = this._canonical!;

    const tile = buildEphemeralTileForStop({
      canonical,
      stopId,
      resolveRouteColor: (rid) => {
        const sm = this.routeSubModeMap.get(rid);
        const entry = this.subModeById.get(sm ?? "");
        const route = canonical.getRoute(rid);
        return entry?.color ?? (route?.color ? `#${route.color}` : undefined);
      },
      resolveRouteSubMode: (rid) => this.routeSubModeMap.get(rid),
    });
    if (!tile) return [];

    const { departures } = getDeparturesFromTile({
      tile,
      stopId,
      now: date,
      limit,
      // Legacy treated `undefined` as "today's remainder + yesterday's overnight rollover, capped
      // only by `limit`", so this is a behavioural narrowing of the public route for callers that
      // omit `lookAheadHours`. Picking a larger default crosses midnight and breaks parity tests
      // because the shared function forward-expands base dates while legacy didn't. The `?? 1`
      // choice is the parity-test-compatible default pending product confirmation; tracked in the
      // tiled stop schedules backlog notes under "Public API behavioural questions".
      lookAheadHours: lookAheadHours ?? 1,
      realtimeUpdates: this.rtUpdatesSnapshot(),
    });
    return departures;
  }

  /**
   * Build a generation-filtered, `RtTripUpdate`-shaped snapshot of
   * `realtimeUpdates` for `getDeparturesFromTile`. Stale entries (written
   * before the last `swap()`) are excluded — matches `getRtUpdate` semantics
   * so the legacy shim sees the same RT view a direct `getRtUpdate` call
   * would.
   */
  /**
   * Public for the fidelity differential (rtTile.fidelity.test.ts) and Stage-B
   * parity; production callers must not rely on the return type stabilising.
   */
  rtUpdatesSnapshot(): ReadonlyMap<string, RtTripUpdate> | undefined {
    if (this.realtimeUpdates.size === 0) return undefined;
    const out = new Map<string, RtTripUpdate>();
    const gen = this.realtimeGeneration;
    for (const [key, entry] of this.realtimeUpdates) {
      if (this.realtimeGenerations.get(key) !== gen) continue;
      // `realtimeUpdates` keys come in two forms: bare `tripId` and
      // date-scoped `${tripId}|${YYYYMMDD}`. The value's `tripId` field
      // must always be the bare trip id per `RtTripUpdate`'s wire
      // contract — otherwise consumers iterating values (telemetry,
      // logs) would see "T1|20260504" as a tripId.
      const pipeIx = key.indexOf("|");
      const tripId = pipeIx >= 0 ? key.slice(0, pipeIx) : key;
      out.set(key, { tripId, delaySeconds: entry.delaySeconds, cancelled: entry.cancelled });
    }
    return out.size > 0 ? out : undefined;
  }

  getStopRouteTripCounts(): Map<string, Map<string, number>> {
    if (!this._mapView) return new Map();
    // Defensive copy — existing return type is mutable `Map<string, Map<string, number>>`.
    const out = new Map<string, Map<string, number>>();
    for (const [stopId, routeCounts] of this._mapView.getStopRouteTripCounts()) {
      out.set(stopId, new Map(routeCounts));
    }
    return out;
  }

  getActiveRoutesByStop(date: Date, lookaheadHours: number): Map<string, Set<string>> {
    if (!this.indexes) return new Map();

    const fiveMinBucket = Math.floor(date.getMinutes() / 5);
    const cacheKey = `${formatDateYYYYMMDD(date)}_${date.getHours()}_${fiveMinBucket}_${lookaheadHours}`;
    const cached = this.activeRoutesCache.get(cacheKey);
    if (cached) return cached;

    // Check today's, yesterday's, and (when the window crosses midnight)
    // tomorrow's services for cross-midnight coverage
    const previousDay = new Date(date);
    previousDay.setDate(previousDay.getDate() - 1);

    const activeToday = this.getActiveServiceIdsForDate(date);
    const activeYesterday = this.getActiveServiceIdsForDate(previousDay);

    const tenMinutesMs = 10 * 60 * 1000;
    const cutoff = new Date(date.getTime() - tenMinutesMs);
    const upperCutoff = new Date(date.getTime() + lookaheadHours * 60 * 60 * 1000);

    const baseDates: { base: Date; services: Set<string> }[] = [
      { base: date, services: activeToday },
      { base: previousDay, services: activeYesterday },
    ];
    {
      const cursor = new Date(date);
      cursor.setHours(0, 0, 0, 0);
      cursor.setDate(cursor.getDate() + 1);
      while (cursor <= upperCutoff) {
        baseDates.push({
          base: new Date(cursor),
          services: this.getActiveServiceIdsForDate(new Date(cursor)),
        });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // Precompute per-base-date window bounds relative to local midnight of each
    // base date. Using local midnight matches CT3's getDepartures alignment —
    // critical for cross-midnight correctness.
    const baseWindows = baseDates.map(({ base, services }) => {
      const baseMidnight = new Date(base);
      baseMidnight.setHours(0, 0, 0, 0);
      const baseMs = baseMidnight.getTime();
      return {
        services,
        lowerSecs: Math.floor((cutoff.getTime() - baseMs) / 1000),
        upperSecs: Math.ceil((upperCutoff.getTime() - baseMs) / 1000),
      };
    });

    const result = new Map<string, Set<string>>();
    const canonical = this._canonical!;

    // Iterate (stop, route) pairs from MapView — O(stops × avg_routes_per_stop).
    // For each pair, check whether any active trip serving that route passes the
    // stop within the time window.
    if (!this._mapView || !this._routingView) return result;

    // Map the existing string-based active-services sets to ServiceIx sets once
    // per base-date window, so inner loops can test membership in O(1) on a
    // uint32 set instead of a string set.
    const identity = this.indexes.identity;
    const baseWindowsIx = baseWindows.map((w) => {
      const ixSet = new Set<number>();
      for (const svcId of w.services) {
        const ix = identity.services.indexOf(svcId);
        if (ix >= 0) ixSet.add(ix);
      }
      return { servicesIx: ixSet, lowerSecs: w.lowerSecs, upperSecs: w.upperSecs };
    });

    for (const [stopId, routeSet] of this._mapView.stopRouteEntries()) {
      for (const routeId of routeSet) {
        const sched = this._routingView.getRouteSchedule(routeId);
        if (!sched) continue;

        const perStop = this.routeStopIndex.get(routeId);
        const stopIdx = perStop?.get(stopId);

        let active = false;
        if (stopIdx !== undefined) {
          // Fast path: stop is in the canonical stop sequence for this route.
          for (const window of baseWindowsIx) {
            if (active) break;
            for (let t = 0; t < sched.tripCount; t++) {
              if (!window.servicesIx.has(sched.serviceIx[t]!)) continue;
              const dep = sched.departureSecs[t * sched.stopCount + stopIdx]!;
              if (dep === DEP_SECS_NOT_SERVED) continue;
              if (dep >= window.lowerSecs && dep <= window.upperSecs) {
                active = true;
                break;
              }
            }
          }
        } else {
          // Variant-pattern fallback: stop only appears in a variant trip.
          // Walk per-stop CompactStopTimes and filter by route ownership.
          const ct = canonical.getCompactStopTimes(stopId);
          if (ct) {
            const { tripIdIdx, departureSecs } = ct;
            fallback: for (const window of baseWindowsIx) {
              for (let i = 0; i < tripIdIdx.length; i++) {
                const dep = departureSecs[i]!;
                if (dep < window.lowerSecs || dep > window.upperSecs) continue;
                const tripId = canonical.getTripIdForIx(tripIdIdx[i]!);
                if (tripId === undefined) continue;
                const trip = canonical.getTrip(tripId);
                if (!trip || trip.routeId !== routeId) continue;
                // serviceId is a string on the trip meta. Convert to ServiceIx
                // for the set lookup (window set is ix-based now).
                const svcIx = identity.services.indexOf(trip.serviceId);
                if (svcIx < 0) continue;
                if (!window.servicesIx.has(svcIx)) continue;
                active = true;
                break fallback;
              }
            }
          }
        }

        if (active) {
          let set = result.get(stopId);
          if (!set) { set = new Set<string>(); result.set(stopId, set); }
          set.add(routeId);
        }
      }
    }

    this.activeRoutesCache.set(cacheKey, result);
    return result;
  }

  /**
   * Return the lat/lon of the first stop (lowest departureSecs) for `tripId`.
   * Returns `null` when the GTFS data is not yet loaded or the trip is unknown.
   * Built once per `swap()` from CompactStopTimes so lookups are O(1).
   */
  getFirstStopLocation(tripId: string): { lat: number; lon: number } | null {
    return this._tripFirstStopLocation.get(tripId) ?? null;
  }

  /**
   * A stop's lat/lon (pure geography). Returns null when the store isn't ready
   * or the stop is unknown.
   *
   * NOTE: B6 made this DEAD on the producer-mode departures path — the stop→tile
   * assignment now comes from the producer-built `stop-cell.json` artifact
   * (`producerDepartures.ts` reads the exact on-disk `.br` coord, not a lat/lon
   * re-derivation). It currently has no live caller in `packages/backend/src`.
   * Retained as a small, generally-useful geography accessor (backend mode reads
   * stop geometry through the canonical store) — do NOT delete it as part of the
   * artifact-shed work; any removal is a separate dead-code pass.
   */
  getStopLatLon(stopId: string): { lat: number; lon: number } | null {
    if (!this.indexes) return null;
    const stop = this._canonical!.getStop(stopId);
    return stop ? { lat: stop.lat, lon: stop.lon } : null;
  }

  /**
   * Attach the TransfersStore used by the PTFT endpoint and PTB response
   * metadata. The transfers artifact has its own on-disk lifecycle and is
   * not tied to the GTFS swap loop.
   */
  setTransfersStore(store: TransfersStore | null): void {
    this._transfersStore = store;
  }

  getTransfersStore(): TransfersStore | null {
    return this._transfersStore;
  }

  // ── Real-time ───────────────────────────────────────────────────────────

  setRealtimeUpdates(
    updates: Map<string, { delaySeconds: number; cancelled: boolean }>,
  ): void {
    this.realtimeUpdates = updates;
    // Tag every incoming entry with the current generation so generation-gated
    // reads (getRtUpdate, rtUpdatesSnapshot, rtEntriesForTrip) can skip entries
    // written before the last swap(). Rebuild BOTH side maps wholesale — NEVER
    // mutate incrementally: stale keys from a prior poll would leak, and keys
    // are date-scoped (`${tripId}|${YYYYMMDD}`) so an append-only generations
    // map grows without bound across service days. Reads only ever look up keys
    // present in the current `realtimeUpdates`/`realtimeTripKeys`, so dropping
    // absent keys is behavior-identical. All three structures are rebuilt from
    // the same loop over the incoming keys so they stay in sync.
    const tripKeys = new Map<string, string[]>();
    const generations = new Map<string, number>();
    const gen = this.realtimeGeneration;
    for (const key of updates.keys()) {
      generations.set(key, gen);
      const pipeIx = key.indexOf("|");
      const tripId = pipeIx >= 0 ? key.slice(0, pipeIx) : key;
      const bucket = tripKeys.get(tripId);
      if (bucket) bucket.push(key);
      else tripKeys.set(tripId, [key]);
    }
    this.realtimeGenerations = generations;
    this.realtimeTripKeys = tripKeys;
  }

  /**
   * Return the RT update for a trip, or undefined if the update is absent or
   * belongs to a previous realtime generation (i.e. was written before the last
   * GTFS swap and has not yet been refreshed by the RT poller).
   */
  getRtUpdate(tripId: string): { delaySeconds: number; cancelled: boolean } | undefined {
    const entry = this.realtimeUpdates.get(tripId);
    if (!entry) return undefined;
    if (this.realtimeGenerations.get(tripId) !== this.realtimeGeneration) return undefined;
    return entry;
  }

  /**
   * All generation-current RT entries for a trip — the bare `tripId` entry
   * (startDate undefined) and each date-scoped `${tripId}|${YYYYMMDD}` entry
   * (startDate set). Per-key generation-gated exactly like `rtUpdatesSnapshot`
   * (NOT the bare-only `getRtUpdate`, which would let a stale date-scoped entry
   * ride the bare key's fresh generation). Returns FRESH objects — never spreads
   * the stored value — so a future `receivedAt` on the store shape cannot leak.
   */
  rtEntriesForTrip(
    tripId: string,
  ): Array<{ startDate?: string; delaySeconds: number; cancelled: boolean }> {
    const keys = this.realtimeTripKeys.get(tripId);
    if (!keys) return [];
    const gen = this.realtimeGeneration;
    const out: Array<{ startDate?: string; delaySeconds: number; cancelled: boolean }> = [];
    for (const key of keys) {
      if (this.realtimeGenerations.get(key) !== gen) continue;
      const entry = this.realtimeUpdates.get(key);
      if (!entry) continue;
      const pipeIx = key.indexOf("|");
      out.push(
        pipeIx >= 0
          ? { startDate: key.slice(pipeIx + 1), delaySeconds: entry.delaySeconds, cancelled: entry.cancelled }
          : { delaySeconds: entry.delaySeconds, cancelled: entry.cancelled },
      );
    }
    return out;
  }

  private bumpRealtimeGeneration(): void {
    this.realtimeGeneration++;
    // Deliberately do NOT clear realtimeUpdates: clearing would cause a blank
    // window until the next RT poll. Instead, incoming entries tagged with the
    // old generation become invisible via generation-gated reads.
  }

  /**
   * Group all real-time updates by routeId.
   * Skips date-scoped keys (containing "|") to avoid duplicates.
   */
  getRealtimeByRoute(): Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }[]> {
    const result = new Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }[]>();
    if (!this.indexes) return result;
    const canonical = this._canonical!;

    for (const key of this.realtimeUpdates.keys()) {
      if (key.includes("|")) continue;
      // Gate by generation: skip entries written before the last swap().
      const update = this.getRtUpdate(key);
      if (!update) continue;

      const trip = canonical.getTrip(key);
      if (!trip) continue;

      let entries = result.get(trip.routeId);
      if (!entries) {
        entries = [];
        result.set(trip.routeId, entries);
      }
      entries.push({
        tripId: key,
        delaySeconds: update.delaySeconds,
        cancelled: update.cancelled,
      });
    }

    return result;
  }

  /**
   * Enumerate all generation-current RT updates, un-grouped (no route key).
   *
   * This is the **index-free** RT enumeration — it touches only the store-resident
   * `realtimeUpdates` map and the per-key generation gate (`getRtUpdate`), with NO
   * `canonical`/index reference. It is the C4-survivable seam: it stays in the store
   * (the RT poller writes there) and outlives the GTFS index deletion. The bare/
   * date-scoped `|`-key skip and per-key generation gating exactly mirror
   * `getRealtimeForRoute`.
   *
   * Producer mode groups these by route via the `trip-route.json` artifact instead
   * of `canonical.getTrip(tripId).routeId`.
   */
  getRealtimeTripUpdates(): { tripId: string; delaySeconds: number; cancelled: boolean }[] {
    const result: { tripId: string; delaySeconds: number; cancelled: boolean }[] = [];

    for (const key of this.realtimeUpdates.keys()) {
      if (key.includes("|")) continue;
      // Gate by generation: skip entries written before the last swap().
      const update = this.getRtUpdate(key);
      if (!update) continue;

      result.push({
        tripId: key,
        delaySeconds: update.delaySeconds,
        cancelled: update.cancelled,
      });
    }

    return result;
  }

  /**
   * Get real-time updates for a single route.
   * Skips date-scoped keys (containing "|") to avoid duplicates.
   */
  getRealtimeForRoute(routeId: string): { tripId: string; delaySeconds: number; cancelled: boolean }[] {
    if (!this.indexes) return [];
    const canonical = this._canonical!;

    const result: { tripId: string; delaySeconds: number; cancelled: boolean }[] = [];

    for (const update of this.getRealtimeTripUpdates()) {
      const trip = canonical.getTrip(update.tripId);
      if (!trip || trip.routeId !== routeId) continue;

      result.push(update);
    }

    return result;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  isReady(): boolean {
    return this.indexes !== null;
  }

  get canonical(): CanonicalStore | undefined {
    return this._canonical;
  }

  get mapView(): MapView | undefined {
    return this._mapView;
  }

  get routingView(): RoutingView | undefined {
    return this._routingView;
  }

  get identity(): import("./identity/types.js").Identity | undefined {
    return this.indexes?.identity;
  }

  getLastUpdated(): Date | null {
    return this.lastUpdated;
  }

  getColorConfig(): ColorConfig | null {
    return this.colorConfig;
  }

  /**
   * Resolve a route's final brand color (`#RRGGBB`) using the sub-mode
   * override; mirrors the inline resolver in `getDepartures`. Returns
   * `undefined` when no sub-mode color override applies — callers fall back
   * to the GTFS `route_color` column themselves.
   *
   * `computeColorConfig` runs synchronously inside `swap()`, so `subModeById`
   * is already populated (or, absent a producer generation, permanently
   * empty) by the time `swap()` returns — no deferred-population window to
   * wait out.
   */
  resolveRouteColor(routeId: string): string | undefined {
    const sm = this.routeSubModeMap.get(routeId);
    if (sm === undefined) return undefined;
    return this.subModeById.get(sm)?.color;
  }

  /**
   * Resolve a route's sub-mode classification (e.g. `EXPRESS_BUS`). Returns
   * `undefined` for routes without a classification — callers may fall back
   * to the route's GTFS `route_type` mode.
   *
   * Like `resolveRouteColor`, `routeSubModeMap` is already in its final state
   * (populated from the producer's `route-styles.json`, or empty when there's
   * no producer generation to read) by the time `swap()` returns.
   */
  resolveRouteSubMode(routeId: string): string | undefined {
    return this.routeSubModeMap.get(routeId);
  }

  /**
   * Point-in-time snapshot of the route color/sub-mode resolvers over DEFENSIVE
   * COPIES of the current color maps. `computeColorConfig` REPLACES
   * `this.routeSubModeMap`/`this.subModeById` on every swap(); the async
   * bundle build spans awaits, so the build captures one snapshot (in its
   * setImmediate prologue — see scheduler.ts) and resolves every tile against
   * it, immune to a mid-build refresh. Color is not a bundleHash input, so a
   * torn bundle would never be refetched — hence the snapshot.
   */
  snapshotRouteResolvers(): RouteResolvers {
    const routeSubModeMap = new Map(this.routeSubModeMap);
    const subModeById = new Map(this.subModeById);
    return {
      resolveRouteColor: (routeId) => {
        const sm = routeSubModeMap.get(routeId);
        if (sm === undefined) return undefined;
        return subModeById.get(sm)?.color;
      },
      resolveRouteSubMode: (routeId) => routeSubModeMap.get(routeId),
    };
  }

  // ── Shapes ──────────────────────────────────────────────────────────────

  /**
   * Return the currently-held shape records. Empty when shapes are disabled
   * (PT_FEATURE_SHAPES=false) or the feed had none.
   */
  getShapes(): RoutingBundleShape[] {
    return this._shapes;
  }

  /**
   * Pre-serialized JSON body of the shapes artifact ({ shapes: [...] }).
   * Cached so the HTTP handler can stream bytes directly without re-serializing
   * on every request. Empty string when no shapes are loaded.
   */
  getShapesBody(): string {
    return this._shapesBody;
  }

  /**
   * sha256 of the serialized shapes body. Used for ETag / manifest hashing.
   * Empty string when no shapes are loaded.
   */
  getShapesHash(): string {
    return this._shapesHash;
  }

  /**
   * Install a new set of shape records. Serializes once and caches body + hash
   * + byte length so subsequent reads are O(1).
   */
  setShapes(shapes: RoutingBundleShape[]): void {
    this._shapes = shapes;
    this._shapesBody = JSON.stringify({ shapes });
    this._shapesHash = createHash("sha256").update(this._shapesBody).digest("hex");
  }

  swap(newIndexes: GtfsIndexes, canonical: CanonicalStore, routingInput: RoutingBuildInput, minTripsPerRoute = 0, generationDir?: string): void {
    this.indexes = newIndexes;
    this._minTripsPerRoute = minTripsPerRoute;
    this._canonical = canonical;                           // no longer built here
    this._mapView = buildMapView({
      canonical,
      stopRouteTripCounts: newIndexes.stopRouteTripCounts,
      minTripsPerRoute,
    });
    this._routingView = buildRoutingView(routingInput, newIndexes.identity);
    this.lastUpdated = new Date();
    this.activeRoutesCache.clear();
    this.allStopsCache = null;

    // Precompute routeStopIndex: Map<routeId, Map<stopId, stopIdx>>
    // Used by getActiveRoutesByStop to resolve (route, stop) pairs in O(1).
    // Under Unbounded mode multiple records share a routeId (one per pattern);
    // we only retain the FIRST (canonical/longest) pattern for each routeId so
    // the fast-path stop-lookup uses the longest-trip sequence. Branch-only
    // stops fall through to the variant-pattern fallback in getActiveRoutesByStop.
    // Rebuilt fresh on every swap so stale index-entries from a previous
    // GTFS version never leak.
    const routeStopIndex = new Map<string, Map<string, number>>();
    for (const { routeId, stopIds } of newIndexes.routeTrips) {
      if (routeStopIndex.has(routeId)) continue; // first-wins per routeId
      const perStop = new Map<string, number>();
      for (let i = 0; i < stopIds.length; i++) {
        perStop.set(stopIds[i]!, i);
      }
      routeStopIndex.set(routeId, perStop);
    }
    this.routeStopIndex = routeStopIndex;

    this.buildSpatialGrid(canonical);
    this.buildLabelAnchors(canonical, generationDir);
    this.buildTripFirstStopIndex(canonical);
    // Color config is read synchronously off disk (cheap `readFileSync` of a
    // small JSON file) when generationDir is set (producer mode) — no need
    // to defer it the way the old in-process clustering computation was.
    // When generationDir is unset (ptb_fallback / gtfs-network), colors stay
    // absent — see computeColorConfig's doc comment.
    this.computeColorConfig(generationDir);
    this.generation += 1;
    // Bump RT generation so any pre-swap RT entries become invisible until the
    // next setRealtimeUpdates() call tags them with the new generation.
    this.bumpRealtimeGeneration();
  }

  private buildSpatialGrid(canonical: CanonicalStore): void {
    const grid = new Map<string, string[]>();
    const cell = GtfsStore.SPATIAL_CELL_DEG;
    canonical.iterStops((stopId, stop) => {
      const key = `${Math.floor(stop.lat / cell)}_${Math.floor(stop.lon / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(stopId);
      else grid.set(key, [stopId]);
    });
    this.spatialGrid = grid;
  }

  /**
   * Read the producer-published `label-anchors.json` for this generation
   * (producer mode — `generationDir` set), or clear anchors entirely when
   * there's no producer generation to read from (`ptb_fallback` /
   * `gtfs-network` deployments). Previously this ran the label-placement
   * solver in-process on every swap; now the producer's Rust pipeline has
   * already solved anchors for this generation (see
   * the color artifacts rust native notes).
   *
   * `canonical` is unused in this mode but kept as a parameter for call-site
   * consistency with `buildSpatialGrid`/`buildTripFirstStopIndex`, which
   * still need it.
   */
  private buildLabelAnchors(_canonical: CanonicalStore, generationDir?: string): void {
    if (!generationDir) {
      this.labelAnchors = new Map();
      return;
    }
    const anchors = this.readArtifactJson<unknown>(generationDir, "label-anchors.json");
    // Same "valid JSON, wrong shape" concern as computeColorConfig: a
    // syntactically-valid but non-object payload (e.g. `null`, `42`, or an
    // array) would otherwise either throw or silently produce a nonsense
    // Map. Guard the shape and log distinctly (mirrors computeColorConfig's
    // logging for the equivalent failure) so this degraded state is
    // operationally visible, not silent. Per-value validation (not just the
    // container) matters too: an out-of-union value (`null`, a typo) doesn't
    // throw anywhere downstream — it's served as-is and the renderer's match
    // expression just falls through to its default case — but a whole
    // malformed file is still a stronger signal to fall through entirely
    // than to serve a mix of valid and garbage anchors.
    if (!isLabelAnchorMap(anchors)) {
      console.error(
        "[gtfs] label-anchors.json missing or malformed in producer generation dir — stops will have no labelAnchor",
      );
      this.labelAnchors = new Map();
      return;
    }
    this.labelAnchors = new Map(Object.entries(anchors));
  }

  /**
   * Build `_tripFirstStopLocation`: scan all CompactStopTimes once and, for
   * each (stopId, tripId) pair, record the stop if its departureSecs is less
   * than any previously seen for that trip. O(total stop-times) per swap.
   */
  private buildTripFirstStopIndex(canonical: CanonicalStore): void {
    // tripId → { lat, lon, minDep }
    const best = new Map<string, { lat: number; lon: number; minDep: number }>();

    canonical.iterCompactStopTimes((stopId, ct) => {
      const stop = canonical.getStop(stopId);
      if (!stop) return;

      for (let i = 0; i < ct.tripIdIdx.length; i++) {
        const tripId = canonical.getTripIdForIx(ct.tripIdIdx[i]!);
        if (tripId === undefined) continue;
        const dep = ct.departureSecs[i]!;
        const existing = best.get(tripId);
        if (!existing || dep < existing.minDep) {
          best.set(tripId, { lat: stop.lat, lon: stop.lon, minDep: dep });
        }
      }
    });

    const result = new Map<string, { lat: number; lon: number }>();
    for (const [tripId, { lat, lon }] of best) {
      result.set(tripId, { lat, lon });
    }
    this._tripFirstStopLocation = result;
  }
}
