import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  scheduleTileCoordAt,
  scheduleCellBounds,
  quadrantDigitForPoint,
} from "@pt/shared/poi";
import type {
  BundleManifest,
  SubdivisionPlan,
  DecodedScheduleTile,
  RtTileResponse,
} from "@pt/shared/schedule-tile";
import type { FetchManifestResult, FetchRtTileResult, FetchScheduleTileResult } from "./api.ts";

// ─── Boundary mocks ───────────────────────────────────────────────────────────
// `@pt/shared/poi` geometry stays REAL (resolved coords are genuine). Only `./api.ts`
// (fetchManifest, fetchRtTile), `./scheduleTileCache.ts` (getDecodedTile),
// `./scheduleTileFlag.ts` (isScheduleTileEnabled), `./errorReporter.ts` (telemetry
// spies), and `../stores/cityStore.ts` (activeCity.tz) are mocked.
// `ManifestUnavailableError` is re-exported REAL from the actual module so
// `instanceof` checks in the read path keep working.

const fetchManifestMock = vi.fn<(cached?: unknown) => Promise<FetchManifestResult>>();
const fetchRtTileMock = vi.fn<(hash: string, size: string, coords: string) => Promise<FetchRtTileResult>>();
// Spy on the legacy per-stop server read so the tile-only batch path can prove
// it never asks the server about a stop (privacy: several stops around the user).
const getDeparturesMock = vi.fn();
vi.mock("./api.ts", async (importActual) => {
  const actual = await importActual<typeof import("./api.ts")>();
  return {
    ...actual,
    fetchManifest: fetchManifestMock,
    fetchRtTile: fetchRtTileMock,
    api: { ...actual.api, getDepartures: getDeparturesMock },
  };
});

const city = vi.hoisted(() => ({ id: "paris" }));

// cityStore mock — provides activeCity.tz used by departuresForStop (K3).
vi.mock("../stores/cityStore.ts", () => ({
  useCityStore: {
    getState: () => ({ activeCity: { id: city.id, tz: "Europe/Paris" } }),
  },
}));

const getDecodedTileMock =
  vi.fn<
    (
      hash: string,
      size: string,
      coords: string,
      opts?: { onTileDownloadStart?: () => void },
    ) => Promise<{ tile: DecodedScheduleTile; bytesDownloaded: number } | { fetchResult: FetchScheduleTileResult }>
  >();
const pruneToBundleHashMock = vi.fn<(hash: string, previousHash?: string) => Promise<void>>(() => Promise.resolve());
const ensureUnderBudgetMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
vi.mock("./scheduleTileCache.ts", () => ({
  getDecodedTile: (h: string, s: string, c: string, o?: { onTileDownloadStart?: () => void }) => {
    o?.onTileDownloadStart?.();
    return getDecodedTileMock(h, s, c, o);
  },
  pruneToBundleHash: (h: string, previous?: string) => pruneToBundleHashMock(h, previous),
  ensureUnderBudget: () => ensureUnderBudgetMock(),
}));

const isScheduleTileEnabledMock = vi.fn<() => boolean>(() => true);
vi.mock("./scheduleTileFlag.ts", () => ({
  isScheduleTileEnabled: () => isScheduleTileEnabledMock(),
}));

const reportTelemetryMock = vi.fn<(event: string, data: Record<string, unknown>) => void>();
const reportErrorMock = vi.fn();
vi.mock("./errorReporter.ts", () => ({
  reportTelemetry: (e: string, d: Record<string, unknown>) => reportTelemetryMock(e, d),
  reportError: (...a: unknown[]) => reportErrorMock(...a),
}));

// Imported AFTER the mocks so the SUT binds the mocked modules. `db` is the real
// fake-indexeddb-backed instance.
const { db } = await import("../db/index.ts");

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

const HASH = "h1";
const SIZE = "6km";

// Paris-ish point: cell 28_906, top-level quadrant 1.
const PARIS = { lat: 48.8566, lon: 2.3522 };
// Southern hemisphere, NEGATIVE y cell 2329_-629, top-level quadrant 3 — the B2
// regression coord (a `coords.split("-")` would corrupt `2329_-629` to `2329_-3`).
const SOUTH = { lat: -33.849, lon: 151.25 };

function cellKeyFor(p: { lat: number; lon: number }): string {
  const { x, y } = scheduleTileCoordAt(p.lat, p.lon);
  return `${x}_${y}`;
}

function topQuadrantFor(p: { lat: number; lon: number }): string {
  const { x, y } = scheduleTileCoordAt(p.lat, p.lon);
  const b = scheduleCellBounds(x, y);
  return String(quadrantDigitForPoint(b, p.lat, p.lon));
}

/** A SubdivisionPlan whose leaves cover the given top-level quadrant suffixes. */
function planWithLeaves(suffixes: string[]): SubdivisionPlan {
  return {
    leaves: suffixes.map((suffix) => ({
      suffix,
      bbox: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 },
      compressedBytes: 1,
      oversized: false,
    })),
  };
}

function manifest(
  bundleHash: string,
  subdivisions?: Record<string, SubdivisionPlan>,
): BundleManifest {
  return { schemaVersion: 1, bundleHash, generatedAt: 0, tileSize: 6000, ...(subdivisions ? { subdivisions } : {}) };
}

function manifestResult(
  bundleHash: string,
  subdivisions?: Record<string, SubdivisionPlan>,
): FetchManifestResult {
  return { manifest: manifest(bundleHash, subdivisions), etag: "etag", bundleHash, fromCache: false };
}

/** Minimal decoded tile. Only `stops[stopId]` presence matters for the read
 *  path's stop-not-in-tile check; `getDeparturesFromTile` is spied in the
 *  defaults test, and elsewhere given enough shape to return a real result. */
function tileWithStop(stopId: string, bundleHash = HASH): DecodedScheduleTile {
  return {
    bundleHash,
    cityId: "test",
    tileSize: 6000,
    stringTable: ["T1", "Downtown"],
    routes: [{ id: "R1", shortName: "42", longName: "42", mode: "BUS" }],
    calendar: [
      {
        serviceId: "S1",
        days: [true, true, true, true, true, true, true],
        startDate: "20000101",
        endDate: "20991231",
        added: [],
        removed: [],
      },
    ],
    trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
    stops: {
      [stopId]: {
        tripIxs: Uint32Array.from([0]),
        departureSecs: Uint32Array.from([0]),
      },
    },
  };
}

function tileWithoutStop(stopId: string, bundleHash = HASH): DecodedScheduleTile {
  const t = tileWithStop(stopId, bundleHash);
  return { ...t, stops: {} };
}

/** Wraps a decoded tile as a successful getDecodedTile return (cache hit, 0 bytes downloaded). */
function okTile(tile: DecodedScheduleTile): { tile: DecodedScheduleTile; bytesDownloaded: number } {
  return { tile, bytesDownloaded: 0 };
}

async function seedStopInStops(id: string, lat: number, lon: number): Promise<void> {
  await db.stops.put({ id, cityId: city.id, name: id, location: { lat, lon }, lastSeen: Date.now() });
}

async function seedStopInGtfsStops(id: string, lat: number, lon: number): Promise<void> {
  await db.gtfsSyncMeta.put({id: "current", cityId: city.id, etag: "fixture", generationId: "fixture", generatedAt: "2026-11-07", lastSynced: 1});
  await db.gtfsStops.put({ id, name: id, lat, lon });
}

async function clearStops(): Promise<void> {
  await db.stops.clear();
  await db.gtfsStops.clear();
}

beforeEach(async () => {
  vi.clearAllMocks();
  city.id = "paris";
  isScheduleTileEnabledMock.mockReturnValue(true);
  pruneToBundleHashMock.mockResolvedValue(undefined);
  ensureUnderBudgetMock.mockResolvedValue(undefined);
  // Default: rt-tile fetch returns 503 (unavailable) so existing tests are unaffected.
  fetchRtTileMock.mockResolvedValue({ status: 503 });
  await clearStops();
});

// `now` far past midnight with the all-days calendar above => "active" result.
const NOW = new Date("2026-06-10T12:00:00Z");

describe("departuresForStop", () => {
  // 1 — single-tile happy path (subdivided cell, real leaf selection)
  it("resolves a subdivided cell to its owning leaf coord and returns ok", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    const suffix = topQuadrantFor(PARIS);
    const plan = planWithLeaves([suffix]);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH, { [cellKey]: plan }));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    expect(getDecodedTileMock).toHaveBeenCalledTimes(1);
    expect(getDecodedTileMock).toHaveBeenCalledWith(HASH, SIZE, `${cellKey}-${suffix}`, expect.any(Object));
    // The resolved coord's cell round-trips to the build cell.
    expect(cellKeyFor(PARIS)).toBe(cellKey);
  });

  // 2 — unsubdivided happy path => bare cellKey
  it("fetches the bare cellKey when the cell is not subdivided", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    expect(getDecodedTileMock).toHaveBeenCalledWith(HASH, SIZE, cellKey, expect.any(Object));
  });

  // 2b — sharedManifest: resolveDecodedTileForStop reuses a caller-supplied
  // manifest WITHOUT re-fetching it (the badge-activity per-round dedup that
  // fixes the manifest-request storm). Without it, each call re-fetches.
  it("resolveDecodedTileForStop reuses a shared manifest without re-fetching it", async () => {
    vi.resetModules();
    const { resolveDecodedTileForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    const r = await resolveDecodedTileForStop(stopId, undefined, {
      manifest: manifest(HASH),
      bundleHash: HASH,
    });

    expect(r.state).toBe("ok");
    expect(fetchManifestMock).not.toHaveBeenCalled(); // used the shared manifest
    expect(getDecodedTileMock).toHaveBeenCalledWith(HASH, SIZE, cellKey, expect.any(Object));
  });

  // 3 — resolveStopLatLon gtfsStops fallback
  it("resolves lat/lon via the gtfsStops fallback table", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-GTFS";
    await seedStopInGtfsStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    expect(getDecodedTileMock).toHaveBeenCalledWith(HASH, SIZE, cellKey, expect.any(Object));
    expect(cellKeyFor(PARIS)).toBe(cellKey);
  });

  // 3b — canonical wins: gtfsStops coord overrides db.stops coord (FIX 3)
  it("prefers the canonical gtfsStops coord over db.stops when both tables have the stop", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-BOTH";
    // Canonical (gtfsStops) = PARIS; API (db.stops) = SOUTH — a different cell.
    await seedStopInGtfsStops(stopId, PARIS.lat, PARIS.lon);
    await seedStopInStops(stopId, SOUTH.lat, SOUTH.lon);
    const canonicalCell = cellKeyFor(PARIS);
    expect(canonicalCell).not.toBe(cellKeyFor(SOUTH)); // distinct cells, so the source is observable
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    // Resolved cell is the CANONICAL one, not the API one.
    expect(getDecodedTileMock).toHaveBeenCalledWith(HASH, SIZE, canonicalCell, expect.any(Object));
  });

  // 4 — resolveStopLatLon neither table => unavailable, ZERO fetches
  it("returns unavailable with no fetches when the stop is in neither table", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const r = await departuresForStop({ stopId: "MISSING", now: NOW });

    expect(r.state).toBe("unavailable");
    expect(fetchManifestMock).not.toHaveBeenCalled();
    expect(getDecodedTileMock).not.toHaveBeenCalled();
  });

  // 5 — null leafForPoint on a subdivided cell => unavailable, NO bare-coord fetch
  it("returns unavailable (no bare fetch) when leafForPoint finds no covering leaf", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    const topQ = topQuadrantFor(PARIS);
    // Subdivide with the OTHER three quadrants so the real leafForPoint => null.
    const others = ["0", "1", "2", "3"].filter((d) => d !== topQ);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH, { [cellKey]: planWithLeaves(others) }));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("unavailable");
    expect(getDecodedTileMock).not.toHaveBeenCalled();
  });

  // 6 — stop_not_in_tile
  it("returns stop_not_in_tile when the decoded tile lacks the stop", async () => {
    vi.resetModules();
    const shared = await import("@pt/shared/transit");
    const getDepSpy = vi.spyOn(shared, "getDeparturesFromTile");
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithoutStop(stopId)));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("stop_not_in_tile");
    expect(getDepSpy).not.toHaveBeenCalled();
    getDepSpy.mockRestore();
  });

  // 7a — bounded cascade 409 -> reResolve -> ok
  it("re-resolves via manifest on 409 and returns ok on the retry", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    // Entry manifest, then the re-resolve manifest (fresh bundleHash).
    fetchManifestMock
      .mockResolvedValueOnce(manifestResult(HASH))
      .mockResolvedValueOnce(manifestResult("h2"));
    getDecodedTileMock
      .mockResolvedValueOnce({ fetchResult: { status: 409, bundleHash: "h2" } })
      .mockResolvedValueOnce(okTile(tileWithStop(stopId, "h2")));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    expect(getDecodedTileMock).toHaveBeenCalledTimes(2);
    expect(fetchManifestMock).toHaveBeenCalledTimes(2); // entry + one re-resolve
    expect(getDecodedTileMock).toHaveBeenLastCalledWith("h2", SIZE, cellKey, expect.any(Object));
  });

  // 7b — 409 then STILL 409 => unavailable
  it("returns unavailable when the 409 retry is still 409", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock
      .mockResolvedValueOnce(manifestResult(HASH))
      .mockResolvedValueOnce(manifestResult("h2"));
    getDecodedTileMock
      .mockResolvedValueOnce({ fetchResult: { status: 409, bundleHash: "h2" } })
      .mockResolvedValueOnce({ fetchResult: { status: 409, bundleHash: "h3" } });

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("unavailable");
    expect(getDecodedTileMock).toHaveBeenCalledTimes(2); // bounded
  });

  // 7c — 429 => unavailable, NO re-resolve
  it("returns unavailable on 429 without a manifest re-resolve", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue({ fetchResult: { status: 429, bundleHash: "h2" } });

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("unavailable");
    expect(fetchManifestMock).toHaveBeenCalledTimes(1); // entry only — no re-resolve
    expect(getDecodedTileMock).toHaveBeenCalledTimes(1);
  });

  // 8 — cascade tile_subdivided 404 (token NOT spent, no refetch)
  it("consumes inlined 404 leaves and retries the leaf coord without a manifest refetch", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    const topQ = topQuadrantFor(PARIS); // "1" for Paris
    // Inline leaves include the owning quadrant + a deeper one; leafForPoint picks topQ.
    const leaves = [topQ, "3-1"];
    fetchManifestMock.mockResolvedValue(manifestResult(HASH)); // unsubdivided at entry
    getDecodedTileMock
      .mockResolvedValueOnce({ fetchResult: { status: 404, leaves } })
      .mockResolvedValueOnce(okTile(tileWithStop(stopId)));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    expect(fetchManifestMock).toHaveBeenCalledTimes(1); // entry only
    expect(getDecodedTileMock).toHaveBeenLastCalledWith(HASH, SIZE, `${cellKey}-${topQ}`, expect.any(Object));
  });

  // 9 — NEGATIVE-coord cascade (B2 regression): cellKey threaded, NOT split("-")
  it("rebuilds the leaf coord from the negative-y cellKey, not a split-corrupted coord", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-SOUTH";
    await seedStopInStops(stopId, SOUTH.lat, SOUTH.lon);
    const cellKey = cellKeyFor(SOUTH); // "2329_-629"
    expect(cellKey).toBe("2329_-629");
    expect(topQuadrantFor(SOUTH)).toBe("3");
    fetchManifestMock.mockResolvedValue(manifestResult(HASH)); // unsubdivided at entry
    getDecodedTileMock
      .mockResolvedValueOnce({ fetchResult: { status: 404, leaves: ["3"] } })
      .mockResolvedValueOnce(okTile(tileWithStop(stopId)));

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    // The FULL negative key + suffix — never "2329_-3".
    expect(getDecodedTileMock).toHaveBeenLastCalledWith(HASH, SIZE, "2329_-629-3", expect.any(Object));
  });

  // 10 — flag-off inertness
  it("is inert when the flag is off (no fetches, no telemetry)", async () => {
    vi.resetModules();
    isScheduleTileEnabledMock.mockReturnValue(false);
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("unavailable");
    expect(fetchManifestMock).not.toHaveBeenCalled();
    expect(getDecodedTileMock).not.toHaveBeenCalled();
    expect(reportTelemetryMock).not.toHaveBeenCalled();
  });

  // 11 — roll-prune across two calls (module-cached manifest)
  it("prunes to the new bundleHash when the manifest rolls between calls", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock
      .mockResolvedValueOnce(manifestResult(HASH)) // first call caches h1
      .mockResolvedValueOnce(manifestResult("h2")); // second call rolls to h2
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId, "h2")));

    await departuresForStop({ stopId, now: NOW });
    expect(pruneToBundleHashMock).not.toHaveBeenCalled(); // first call: no prior hash
    await departuresForStop({ stopId, now: NOW });

    expect(pruneToBundleHashMock).toHaveBeenCalledWith("h2", HASH);
  });

  // 12 — defaults (R16): limit/lookAhead forwarding
  it("forwards default limit/lookAhead and the lookAhead-with-limit override", async () => {
    vi.resetModules();
    const shared = await import("@pt/shared/transit");
    const getDepSpy = vi
      .spyOn(shared, "getDeparturesFromTile")
      .mockReturnValue({ departures: [], serviceState: "active" });
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    // No lookAheadHours, no limit => limit 20, lookAhead 1.
    await departuresForStop({ stopId, now: NOW });
    expect(getDepSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, lookAheadHours: 1 }),
    );

    // lookAheadHours: 2, no limit => limit 100, lookAhead 2.
    await departuresForStop({ stopId, now: NOW, lookAheadHours: 2 });
    expect(getDepSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 100, lookAheadHours: 2 }),
    );

    getDepSpy.mockRestore();
  });

  // 13 — regex-drop (C5): NOT forced through the real path. The real `leafForPoint` only ever
  // returns valid 0..3 digit suffixes joined by "-", so `${cellKey}-${suffix}` always satisfies
  // TILE_COORD_RE for a valid cellKey. Forcing a TILE_COORD_RE failure would require contorting the
  // geometry (or mocking @pt/shared/poi, which this suite deliberately keeps real). The C5 guard is
  // exercised independently by getDecodedTile's own regex-drop test. Left intentionally unforced
  // here per the plan.
  it.skip("C5 regex-drop guard (covered by getDecodedTile's own test; not forceable via the real leafForPoint)", () => {
    expect(true).toBe(true);
  });

  // 14 — cascade-exhausted telemetry (R21): bundle_thrash breadcrumb
  it("emits a bundle_thrash telemetry breadcrumb when the cascade exhausts", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock
      .mockResolvedValueOnce(manifestResult(HASH))
      .mockResolvedValueOnce(manifestResult("h2"));
    getDecodedTileMock
      .mockResolvedValueOnce({ fetchResult: { status: 409, bundleHash: "h2" } })
      .mockResolvedValueOnce({ fetchResult: { status: 409, bundleHash: "h3" } });

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("unavailable");
    expect(reportTelemetryMock).toHaveBeenCalledWith(
      "bundle_thrash",
      expect.objectContaining({ stopId }),
    );
  });

  // 15 — flag-on breadcrumb (R22): schedule_tile_resolve with tileCoords + subdivided
  it("emits a schedule_tile_resolve breadcrumb on the flag-on happy path", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    const suffix = topQuadrantFor(PARIS);
    fetchManifestMock.mockResolvedValue(
      manifestResult(HASH, { [cellKey]: planWithLeaves([suffix]) }),
    );
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    await departuresForStop({ stopId, now: NOW });

    const resolveCalls = reportTelemetryMock.mock.calls.filter(
      (c) => c[0] === "schedule_tile_resolve",
    );
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]![1]).toEqual(
      expect.objectContaining({ tileCoords: `${cellKey}-${suffix}`, subdivided: true }),
    );
  });

  it("emits no telemetry when the flag is off", async () => {
    vi.resetModules();
    isScheduleTileEnabledMock.mockReturnValue(false);
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);

    await departuresForStop({ stopId, now: NOW });

    expect(reportTelemetryMock).not.toHaveBeenCalled();
  });



  // (a) tile-ok + rt-ok dual-entry (bare tripId + tripId|YYYYMMDD): live rows carry
  //     predictedTime; unmatched departure stays scheduled (no predictedTime).
  it("(a) rt-tile 200: matched departure has predictedTime; unmatched stays scheduled", async () => {
    vi.resetModules();
    const shared = await import("@pt/shared/transit");
    const getDepSpy = vi
      .spyOn(shared, "getDeparturesFromTile")
      .mockReturnValue({
        departures: [
          { tripId: "T1", routeId: "R1", scheduledTime: "2026-06-10T12:00:00Z", predictedTime: "2026-06-10T12:02:00Z", delaySeconds: 120, cancelled: false, headsign: "Downtown", mode: "BUS" } as unknown as import("@pt/shared").Departure,
          { tripId: "T2", routeId: "R1", scheduledTime: "2026-06-10T12:10:00Z", cancelled: false, headsign: "Downtown", mode: "BUS" } as unknown as import("@pt/shared").Departure,
        ],
        serviceState: "active",
      });

    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);

    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    const rtBody: RtTileResponse = {
      bundleHash: HASH,
      generatedAt: Date.now(),
      trips: [
        // bare key
        { tripId: "T1", delaySeconds: 120, cancelled: false },
        // date-scoped key — matches when getDeparturesFromTile looks up `T2|20260610`
        { tripId: "T2", startDate: "20260610", delaySeconds: 300, cancelled: false },
      ],
    };
    fetchRtTileMock.mockResolvedValue({ status: 200, body: rtBody });

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    // Matched departure (T1) carries predictedTime.
    expect(r.departures[0]!.predictedTime).toBe("2026-06-10T12:02:00Z");
    // Unmatched departure (T2 bare, no startDate) stays scheduled.
    expect(r.departures[1]!.predictedTime).toBeUndefined();

    // getDeparturesFromTile was called with realtimeUpdates containing both keys.
    expect(getDepSpy).toHaveBeenCalledTimes(1);
    const callArgs = getDepSpy.mock.calls[0]![0];
    expect(callArgs.realtimeUpdates).toBeDefined();
    expect(callArgs.realtimeUpdates!.has("T1")).toBe(true);
    expect(callArgs.realtimeUpdates!.has("T2|20260610")).toBe(true);
    // tz threaded through
    expect(callArgs.tz).toBe("Europe/Paris");
    // rt_tile_unavailable NOT emitted
    expect(reportTelemetryMock).not.toHaveBeenCalledWith("rt_tile_unavailable", expect.anything());

    // rt-tile fetched at the resolved (post-cascade) coords
    expect(fetchRtTileMock).toHaveBeenCalledWith(HASH, "6km", cellKey);

    getDepSpy.mockRestore();
  });

  // (b) tile-ok + rt non-200: all-scheduled (realtimeUpdates undefined), one
  //     rt_tile_unavailable telemetry, no throw, no /departures fallback.
  it("(b) rt-tile non-200: departures all-scheduled, rt_tile_unavailable emitted, no throw", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);

    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));
    fetchRtTileMock.mockResolvedValue({ status: 503 });

    const r = await departuresForStop({ stopId, now: NOW });

    // Still returns ok (degraded schedule-only, no throw/fallback).
    expect(r.state).toBe("ok");
    // One rt_tile_unavailable telemetry with the stop id.
    const unavailCalls = reportTelemetryMock.mock.calls.filter((c) => c[0] === "rt_tile_unavailable");
    expect(unavailCalls).toHaveLength(1);
    expect(unavailCalls[0]![1]).toEqual(expect.objectContaining({ stopId, reason: "503" }));
  });

  // (b2) network error (status: 0): reason="network"
  it("(b2) rt-tile network error (status:0): reason=network in rt_tile_unavailable", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);

    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));
    fetchRtTileMock.mockResolvedValue({ status: 0 });

    const r = await departuresForStop({ stopId, now: NOW });

    expect(r.state).toBe("ok");
    const unavailCalls = reportTelemetryMock.mock.calls.filter((c) => c[0] === "rt_tile_unavailable");
    expect(unavailCalls).toHaveLength(1);
    expect(unavailCalls[0]![1]).toEqual(expect.objectContaining({ reason: "network" }));
  });

  // (c) realtimeUpdates map is keyed `startDate ? tripId|startDate : tripId`
  it("(c) realtimeUpdates map key uses startDate when present, bare tripId otherwise", async () => {
    vi.resetModules();
    const shared = await import("@pt/shared/transit");
    const getDepSpy = vi
      .spyOn(shared, "getDeparturesFromTile")
      .mockReturnValue({ departures: [], serviceState: "active" });
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStop(stopId)));

    const rtBody: RtTileResponse = {
      bundleHash: HASH,
      generatedAt: Date.now(),
      trips: [
        { tripId: "TRIP-A", startDate: "20260610", delaySeconds: 60, cancelled: false },
        { tripId: "TRIP-B", delaySeconds: 120, cancelled: false },
        { tripId: "TRIP-C", startDate: "20260611", delaySeconds: 0, cancelled: true },
      ],
    };
    fetchRtTileMock.mockResolvedValue({ status: 200, body: rtBody });

    await departuresForStop({ stopId, now: NOW });

    const callArgs = getDepSpy.mock.calls[0]![0];
    const rtMap = callArgs.realtimeUpdates!;
    expect(rtMap.has("TRIP-A|20260610")).toBe(true);   // date-scoped
    expect(rtMap.has("TRIP-A")).toBe(false);           // NOT bare key
    expect(rtMap.has("TRIP-B")).toBe(true);            // bare key (no startDate)
    expect(rtMap.has("TRIP-C|20260611")).toBe(true);   // date-scoped
    // Value includes tripId (K2 — required by RtTripUpdate)
    expect(rtMap.get("TRIP-A|20260610")!.tripId).toBe("TRIP-A");
    expect(rtMap.get("TRIP-B")!.tripId).toBe("TRIP-B");

    getDepSpy.mockRestore();
  });

  // (d) rt-tile is fetched at post-cascade coords (subdivided-leaf case)
  it("(d) rt-tile is fetched at the post-cascade (leaf) coords, not the entry coords", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    const cellKey = cellKeyFor(PARIS);
    const topQ = topQuadrantFor(PARIS);
    const leafCoord = `${cellKey}-${topQ}`;

    // Entry manifest has no subdivision; the first tile fetch returns tile_subdivided
    // with the owning leaf, so the cascade resolves to the leaf coord.
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock
      .mockResolvedValueOnce({ fetchResult: { status: 404, leaves: [topQ] } }) // subdivided
      .mockResolvedValueOnce(okTile(tileWithStop(stopId)));                    // leaf hit
    fetchRtTileMock.mockResolvedValue({ status: 503 });

    await departuresForStop({ stopId, now: NOW });

    // rt-tile was fetched at the POST-cascade leaf coord (not the bare cellKey).
    expect(fetchRtTileMock).toHaveBeenCalledWith(HASH, "6km", leafCoord);
    expect(fetchRtTileMock).not.toHaveBeenCalledWith(HASH, "6km", cellKey);
  });
});

describe("resolveWithCascade returns resolved bundleHash/tileCoords (G3)", () => {
  // Direct test: call the exported resolveWithCascade and assert the result
  // exposes `tileCoords` and `bundleHash` (not just `tile`).
  // FAILS before the implementation because the current return type is
  // `{ tile } | null` — no `tileCoords` or `bundleHash` fields.
  it("tile_subdivided 404 → leaf descent → result.tileCoords === '<cell>-<suffix>' and result.bundleHash equals the producing hash", async () => {
    vi.resetModules();
    const mod = await import("./scheduleTileReadPath.ts");
    // resolveWithCascade must be exported for this test.
    const resolveWithCascade = (mod as unknown as { resolveWithCascade: (...args: unknown[]) => Promise<unknown> }).resolveWithCascade;
    expect(resolveWithCascade, "resolveWithCascade must be exported").toBeDefined();

    const cellKey = cellKeyFor(PARIS);
    const suffix = topQuadrantFor(PARIS);
    const leafCoord = `${cellKey}-${suffix}`;
    const cellBounds = scheduleCellBounds(
      parseInt(cellKey.split("_")[0]!),
      parseInt(cellKey.split("_")[1]!),
    );
    const tile = tileWithStop("S1", HASH);

    getDecodedTileMock
      .mockResolvedValueOnce({ fetchResult: { status: 404, leaves: [suffix, "3-1"] } })
      .mockResolvedValueOnce(okTile(tile));

    const result = await resolveWithCascade(HASH, cellKey, cellKey, cellBounds, PARIS, false) as Record<string, unknown> | null;

    expect(result).not.toBeNull();
    // The key assertion: result must expose tileCoords and bundleHash.
    expect(result!["tileCoords"]).toBe(leafCoord);
    expect(result!["bundleHash"]).toBe(HASH);
    expect(result!["tile"]).toBe(tile);
  });
});

describe("HEDGE_MS / resolveTileCoordsForLatLon / warmManifest / getters", () => {
  it("HEDGE_MS is a non-negative number", async () => {
    vi.resetModules();
    const { HEDGE_MS } = await import("./scheduleTileReadPath.ts");
    expect(HEDGE_MS).toBeGreaterThanOrEqual(0);
  });

  it("departuresForStop forwards onTileDownloadStart to the cache layer", async () => {
    vi.resetModules();
    const { departuresForStop } = await import("./scheduleTileReadPath.ts");

    const stopId = "STOP-PARIS";
    await seedStopInStops(stopId, PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue({ tile: tileWithStop(stopId), bytesDownloaded: 5 });

    const onDl = vi.fn();
    await departuresForStop({ stopId, now: NOW }, { onTileDownloadStart: onDl });
    expect(onDl).toHaveBeenCalled();
  });

  it("warmManifest seeds currentBundleHash/currentManifest", async () => {
    vi.resetModules();
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    const { warmManifest, currentBundleHash, currentManifest } = await import("./scheduleTileReadPath.ts");
    await warmManifest();
    expect(currentBundleHash()).not.toBeNull();
    expect(currentManifest()).not.toBeNull();
  });

  it("warmManifest prunes stale tiles when the bundle rolls between calls", async () => {
    vi.resetModules();
    const { warmManifest } = await import("./scheduleTileReadPath.ts");
    fetchManifestMock
      .mockResolvedValueOnce(manifestResult(HASH))   // first warm: seed h1
      .mockResolvedValueOnce(manifestResult("h2"));  // second warm: rolled to h2
    await warmManifest();
    expect(pruneToBundleHashMock).not.toHaveBeenCalled(); // no prior hash
    await warmManifest();
    expect(pruneToBundleHashMock).toHaveBeenCalledWith("h2", HASH);
  });

  it("warmManifest does not throw when fetchManifest rejects, and leaves getters null", async () => {
    vi.resetModules();
    fetchManifestMock.mockRejectedValue(new Error("network failure"));
    const { warmManifest, currentBundleHash, currentManifest } = await import("./scheduleTileReadPath.ts");
    // Must resolve (not throw) even when the fetch fails.
    await expect(warmManifest()).resolves.toBeUndefined();
    // Getters remain null — no stale state was written.
    expect(currentBundleHash()).toBeNull();
    expect(currentManifest()).toBeNull();
  });

  it("resolveTileCoordsForLatLon returns the correct leaf coord for a subdivided cell", async () => {
    vi.resetModules();
    const { resolveTileCoordsForLatLon } = await import("./scheduleTileReadPath.ts");

    const cellKey = cellKeyFor(PARIS);
    const suffix = topQuadrantFor(PARIS);
    const plan = planWithLeaves([suffix]);
    const man = manifest(HASH, { [cellKey]: plan });

    const result = resolveTileCoordsForLatLon(man, PARIS.lat, PARIS.lon);
    expect(result).toBe(`${cellKey}-${suffix}`);
  });

  it("resolveTileCoordsForLatLon returns bare cellKey when not subdivided", async () => {
    vi.resetModules();
    const { resolveTileCoordsForLatLon } = await import("./scheduleTileReadPath.ts");

    const cellKey = cellKeyFor(PARIS);
    const man = manifest(HASH);

    const result = resolveTileCoordsForLatLon(man, PARIS.lat, PARIS.lon);
    expect(result).toBe(cellKey);
  });

  it("resolveTileCoordsForLatLon returns null when leafForPoint finds no covering leaf", async () => {
    vi.resetModules();
    const { resolveTileCoordsForLatLon } = await import("./scheduleTileReadPath.ts");

    const cellKey = cellKeyFor(PARIS);
    const topQ = topQuadrantFor(PARIS);
    const others = ["0", "1", "2", "3"].filter((d) => d !== topQ);
    const man = manifest(HASH, { [cellKey]: planWithLeaves(others) });

    const result = resolveTileCoordsForLatLon(man, PARIS.lat, PARIS.lon);
    expect(result).toBeNull();
  });
});

describe("departuresForStops (several stops, tile-only)", () => {
  // A second cell ~11 km north of PARIS: a different 6 km tile.
  const NORTH = { lat: 48.9566, lon: 2.3522 };

  /** A decoded tile carrying every given stop (same shape as tileWithStop). */
  function tileWithStops(stopIds: string[], bundleHash = HASH): DecodedScheduleTile {
    const t = tileWithStop(stopIds[0]!, bundleHash);
    return {
      ...t,
      stops: Object.fromEntries(stopIds.map((id) => [id, {
        tripIxs: Uint32Array.from([0]),
        departureSecs: Uint32Array.from([0]),
      }])),
    };
  }

  function dep(stopId: string): import("@pt/shared").Departure {
    return {
      tripId: `T-${stopId}`,
      routeId: "R1",
      routeShortName: "42",
      mode: "BUS",
      headsign: "Downtown",
      scheduledTime: "2026-06-10T12:05:00Z",
    };
  }

  /** Spy `getDeparturesFromTile` so every resolved stop yields one departure
   *  tagged with its own id. Must run after `vi.resetModules()` and before the
   *  SUT import, like the spies above. */
  async function spyDepartures() {
    const shared = await import("@pt/shared/transit");
    return vi
      .spyOn(shared, "getDeparturesFromTile")
      .mockImplementation(({ stopId }) => ({ departures: [dep(stopId)], serviceState: "active" }));
  }

  beforeEach(() => {
    getDecodedTileMock.mockReset();
  });

  it("fetches the manifest once, one rt-tile per distinct resolved tile, and never /departures", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    const cellA = cellKeyFor(PARIS);
    const cellB = cellKeyFor(NORTH);
    expect(cellA).not.toBe(cellB);
    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    await seedStopInStops("A2", PARIS.lat, PARIS.lon + 0.001);
    await seedStopInStops("B1", NORTH.lat, NORTH.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockImplementation(async (_h, _s, coords) =>
      okTile(coords === cellA ? tileWithStops(["A1", "A2"]) : tileWithStops(["B1"])));

    const r = await departuresForStops({ stopIds: ["A1", "B1", "A2", "A1"], now: NOW });

    expect([...r.keys()].sort()).toEqual(["A1", "A2", "B1"]);
    expect(r.get("A2")![0]!.tripId).toBe("T-A2");
    expect(fetchManifestMock).toHaveBeenCalledTimes(1);
    expect(fetchRtTileMock).toHaveBeenCalledTimes(2);
    expect(fetchRtTileMock).toHaveBeenCalledWith(HASH, "6km", cellA);
    expect(fetchRtTileMock).toHaveBeenCalledWith(HASH, "6km", cellB);
    // A duplicate id is resolved once.
    expect(getDecodedTileMock).toHaveBeenCalledTimes(3);
    expect(getDeparturesMock).not.toHaveBeenCalled();
    getDepSpy.mockRestore();
  });

  it("resolves stops sequentially (never two getDecodedTile calls in flight)", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    const ids = ["S1", "S2", "S3", "S4"];
    for (const [i, id] of ids.entries()) await seedStopInStops(id, PARIS.lat, PARIS.lon + i * 0.001);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    let inFlight = 0;
    let maxInFlight = 0;
    getDecodedTileMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      return okTile(tileWithStops(ids));
    });

    const r = await departuresForStops({ stopIds: ids, now: NOW });

    expect(r.size).toBe(4);
    expect(getDecodedTileMock).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(1);
    getDepSpy.mockRestore();
  });

  it("omits stop_not_in_tile and unavailable stops", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    await seedStopInStops("IN", PARIS.lat, PARIS.lon);
    await seedStopInStops("NOT-IN-TILE", PARIS.lat, PARIS.lon + 0.001);
    // "NO-COORD" is in neither stops table → unavailable.
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStops(["IN"])));

    const r = await departuresForStops({ stopIds: ["IN", "NOT-IN-TILE", "NO-COORD"], now: NOW });

    expect([...r.keys()]).toEqual(["IN"]);
    expect(getDepSpy).toHaveBeenCalledTimes(1);
    expect(getDeparturesMock).not.toHaveBeenCalled();
    getDepSpy.mockRestore();
  });

  it("returns an empty map with no fetches when the flag is off", async () => {
    vi.resetModules();
    isScheduleTileEnabledMock.mockReturnValue(false);
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    const r = await departuresForStops({ stopIds: ["A1"], now: NOW });

    expect(r.size).toBe(0);
    expect(fetchManifestMock).not.toHaveBeenCalled();
    expect(getDecodedTileMock).not.toHaveBeenCalled();
    expect(fetchRtTileMock).not.toHaveBeenCalled();
    expect(getDeparturesMock).not.toHaveBeenCalled();
  });

  it("returns an empty map without resolving any stop when the manifest is unavailable", async () => {
    vi.resetModules();
    const { ManifestUnavailableError } = await import("./api.ts");
    fetchManifestMock.mockRejectedValue(new ManifestUnavailableError());
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    await seedStopInStops("A2", PARIS.lat, PARIS.lon + 0.001);
    const r = await departuresForStops({ stopIds: ["A1", "A2"], now: NOW });

    expect(r.size).toBe(0);
    // One warm attempt for the whole batch, never one per stop.
    expect(fetchManifestMock).toHaveBeenCalledTimes(1);
    expect(getDecodedTileMock).not.toHaveBeenCalled();
    expect(fetchRtTileMock).not.toHaveBeenCalled();
    expect(getDeparturesMock).not.toHaveBeenCalled();
  });

  it("returns an empty map for an empty stop list without any fetch", async () => {
    vi.resetModules();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    const r = await departuresForStops({ stopIds: [], now: NOW });

    expect(r.size).toBe(0);
    expect(fetchManifestMock).not.toHaveBeenCalled();
    expect(getDecodedTileMock).not.toHaveBeenCalled();
  });

  it("layers the rt-tile updates of each stop's own tile", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    const cellA = cellKeyFor(PARIS);
    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    await seedStopInStops("B1", NORTH.lat, NORTH.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockImplementation(async (_h, _s, coords) =>
      okTile(coords === cellA ? tileWithStops(["A1"]) : tileWithStops(["B1"])));
    fetchRtTileMock.mockImplementation(async (_h, _s, coords) => coords === cellA
      ? {
        status: 200,
        body: {
          bundleHash: HASH,
          generatedAt: Date.now(),
          trips: [{ tripId: "TA", startDate: "20260610", delaySeconds: 60, cancelled: false }],
        },
      }
      : { status: 503 });

    await departuresForStops({ stopIds: ["A1", "B1"], now: NOW });

    const byStop = new Map(getDepSpy.mock.calls.map((c) => [c[0].stopId, c[0]]));
    expect(byStop.get("A1")!.realtimeUpdates!.get("TA|20260610")).toEqual(
      { tripId: "TA", delaySeconds: 60, cancelled: false },
    );
    expect(byStop.get("B1")!.realtimeUpdates).toBeUndefined();
    expect(byStop.get("A1")!.tz).toBe("Europe/Paris");
    getDepSpy.mockRestore();
  });

  it("still returns schedule-only departures when the rt-tile answers 409", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStops(["A1"])));
    fetchRtTileMock.mockResolvedValue({ status: 409 });

    const r = await departuresForStops({ stopIds: ["A1"], now: NOW });

    expect(r.get("A1")).toEqual([dep("A1")]);
    expect(getDepSpy.mock.calls[0]![0].realtimeUpdates).toBeUndefined();
    const unavail = reportTelemetryMock.mock.calls.filter((c) => c[0] === "rt_tile_unavailable");
    expect(unavail).toHaveLength(1);
    expect(unavail[0]![1]).toEqual(expect.objectContaining({ reason: "409" }));
    expect(getDeparturesMock).not.toHaveBeenCalled();
    getDepSpy.mockRestore();
  });

  it("a throw for one stop does not drop the others", async () => {
    vi.resetModules();
    const shared = await import("@pt/shared/transit");
    const getDepSpy = vi
      .spyOn(shared, "getDeparturesFromTile")
      .mockImplementation(({ stopId }) => {
        if (stopId === "A2") throw new Error("corrupt stop row");
        return { departures: [dep(stopId)], serviceState: "active" };
      });
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    const cellB = cellKeyFor(NORTH);
    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    await seedStopInStops("A2", PARIS.lat, PARIS.lon + 0.001);
    await seedStopInStops("B1", NORTH.lat, NORTH.lon);
    await seedStopInStops("A3", PARIS.lat, PARIS.lon + 0.002);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockImplementation(async (_h, _s, coords) => {
      if (coords === cellB) throw new Error("tile decode failed");
      return okTile(tileWithStops(["A1", "A2", "A3"]));
    });

    const r = await departuresForStops({ stopIds: ["A1", "B1", "A2", "A3"], now: NOW });

    // B1's resolve threw, A2's departure read threw; A1 and A3 survive.
    expect([...r.keys()].sort()).toEqual(["A1", "A3"]);
    getDepSpy.mockRestore();
  });

  it("forwards the lookAhead/limit defaults of departuresForStop", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStops(["A1"])));

    await departuresForStops({ stopIds: ["A1"], now: NOW });
    expect(getDepSpy.mock.calls[0]![0]).toEqual(expect.objectContaining({ now: NOW, lookAheadHours: 1, limit: 20 }));

    await departuresForStops({ stopIds: ["A1"], now: NOW, lookAheadHours: 2 });
    expect(getDepSpy.mock.calls[1]![0]).toEqual(expect.objectContaining({ lookAheadHours: 2, limit: 100 }));
    getDepSpy.mockRestore();
  });

  it("fetches a cascaded stop's rt-tile at the hash the 409 cascade landed it on", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    const cellA = cellKeyFor(PARIS);
    const cellB = cellKeyFor(NORTH);
    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    await seedStopInStops("B1", NORTH.lat, NORTH.lon);
    // The batch's warm manifest is h1; B1's tile answers 409 there, and the
    // cascade's one manifest refetch moves it to h2.
    fetchManifestMock
      .mockResolvedValueOnce(manifestResult(HASH))
      .mockResolvedValueOnce(manifestResult("h2"));
    getDecodedTileMock.mockImplementation(async (hash, _s, coords) => {
      if (coords === cellB && hash === HASH) return { fetchResult: { status: 409 } };
      return okTile(coords === cellA ? tileWithStops(["A1"]) : tileWithStops(["B1"], hash));
    });

    const r = await departuresForStops({ stopIds: ["A1", "B1"], now: NOW });

    expect([...r.keys()].sort()).toEqual(["A1", "B1"]);
    expect(fetchManifestMock).toHaveBeenCalledTimes(2);
    expect(fetchRtTileMock).toHaveBeenCalledTimes(2);
    expect(fetchRtTileMock).toHaveBeenCalledWith(HASH, "6km", cellA);
    expect(fetchRtTileMock).toHaveBeenCalledWith("h2", "6km", cellB);
    getDepSpy.mockRestore();
  });

  it("a failing cache-budget sweep never fails the batch", async () => {
    vi.resetModules();
    const getDepSpy = await spyDepartures();
    const { departuresForStops } = await import("./scheduleTileReadPath.ts");

    await seedStopInStops("A1", PARIS.lat, PARIS.lon);
    fetchManifestMock.mockResolvedValue(manifestResult(HASH));
    getDecodedTileMock.mockResolvedValue(okTile(tileWithStops(["A1"])));
    ensureUnderBudgetMock.mockRejectedValue(new Error("IDB quota"));

    const r = await departuresForStops({ stopIds: ["A1"], now: NOW });

    expect(r.get("A1")).toEqual([dep("A1")]);
    expect(ensureUnderBudgetMock).toHaveBeenCalledTimes(1);
    getDepSpy.mockRestore();
  });

  describe("abort", () => {
    it("an aborted signal stops the batch between stops", async () => {
      vi.resetModules();
      const getDepSpy = await spyDepartures();
      const { departuresForStops } = await import("./scheduleTileReadPath.ts");

      await seedStopInStops("A1", PARIS.lat, PARIS.lon);
      await seedStopInStops("A2", PARIS.lat, PARIS.lon + 0.001);
      fetchManifestMock.mockResolvedValue(manifestResult(HASH));
      const controller = new AbortController();
      getDecodedTileMock.mockImplementation(async () => {
        // The caller moves on while the first stop resolves.
        controller.abort();
        return okTile(tileWithStops(["A1", "A2"]));
      });

      const r = await departuresForStops({ stopIds: ["A1", "A2"], now: NOW, signal: controller.signal });

      expect(r.size).toBe(0);
      expect(getDecodedTileMock).toHaveBeenCalledTimes(1);
      expect(fetchRtTileMock).not.toHaveBeenCalled();
      getDepSpy.mockRestore();
    });

    it("a signal aborted before the batch resolves nothing", async () => {
      vi.resetModules();
      const { departuresForStops } = await import("./scheduleTileReadPath.ts");

      await seedStopInStops("A1", PARIS.lat, PARIS.lon);
      fetchManifestMock.mockResolvedValue(manifestResult(HASH));
      const controller = new AbortController();
      controller.abort();

      const r = await departuresForStops({ stopIds: ["A1"], now: NOW, signal: controller.signal });

      expect(r.size).toBe(0);
      expect(getDecodedTileMock).not.toHaveBeenCalled();
      expect(fetchRtTileMock).not.toHaveBeenCalled();
    });
  });

  // The live overlay is shared by every tile read: the stop popup and the
  // departure sheet (`departuresForStop`) and the map strip (both reads).
  describe("rt-tile: privacy level and reuse", () => {
    type PrivacyStore = typeof import("../stores/privacyStore.ts").usePrivacyStore;

    afterEach(async () => {
      const { usePrivacyStore } = await import("../stores/privacyStore.ts");
      usePrivacyStore.setState({ level: "standard", overrides: {} });
      localStorage.removeItem("ptn-privacy");
      vi.restoreAllMocks();
    });

    /** Fresh modules, the privacy store set up by `apply`, then the SUT. */
    async function loadAt(apply: (store: PrivacyStore) => void) {
      vi.resetModules();
      const { usePrivacyStore } = await import("../stores/privacyStore.ts");
      apply(usePrivacyStore);
      return import("./scheduleTileReadPath.ts");
    }

    async function seedTwoStopsInOneTile() {
      await seedStopInStops("A1", PARIS.lat, PARIS.lon);
      await seedStopInStops("A2", PARIS.lat, PARIS.lon + 0.001);
      fetchManifestMock.mockResolvedValue(manifestResult(HASH));
      getDecodedTileMock.mockResolvedValue(okTile(tileWithStops(["A1", "A2"])));
      fetchRtTileMock.mockResolvedValue({
        status: 200,
        body: { bundleHash: HASH, generatedAt: 0, trips: [{ tripId: "T1", delaySeconds: 60, cancelled: false }] },
      });
    }

    it.each([
      ["the strict level", (s: PrivacyStore) =>
        s.setState({ level: "strict", overrides: {} })],
      ["a realTimePolling override", (s: PrivacyStore) =>
        s.setState({ level: "standard", overrides: { realTimePolling: "disabled-schedule-only" } })],
    ])("fetches no /gtfs/rt-tile/ at the schedule-only level (%s)", async (_name, apply) => {
      const { departuresForStop, departuresForStops } = await loadAt(apply);
      await seedTwoStopsInOneTile();

      const single = await departuresForStop({ stopId: "A1", now: NOW });
      const batch = await departuresForStops({ stopIds: ["A2"], now: NOW });

      expect(single.state).toBe("ok");
      expect(batch.has("A2")).toBe(true);
      expect(fetchRtTileMock).not.toHaveBeenCalled();
      // A deliberate skip, not an outage: no rt_tile_unavailable breadcrumb.
      expect(reportTelemetryMock).not.toHaveBeenCalledWith("rt_tile_unavailable", expect.anything());
    });

    it("still fetches it at the default level", async () => {
      const { departuresForStop } = await loadAt((s) => s.setState({ level: "standard", overrides: {} }));
      await seedTwoStopsInOneTile();

      await departuresForStop({ stopId: "A1", now: NOW });

      expect(fetchRtTileMock).toHaveBeenCalledTimes(1);
      expect(fetchRtTileMock).toHaveBeenCalledWith(HASH, "6km", cellKeyFor(PARIS));
    });

    it("reuses a tile's rt-tile within RT_TILE_REUSE_MS, in flight or settled, and refetches after", async () => {
      const { departuresForStop, departuresForStops, RT_TILE_REUSE_MS } =
        await loadAt((s) => s.setState({ level: "standard", overrides: {} }));
      await seedTwoStopsInOneTile();
      const t0 = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(t0);

      // The strip: its nearest stop and the batch for the pole across the
      // street, in the same tile, side by side.
      await Promise.all([
        departuresForStop({ stopId: "A1", now: NOW }),
        departuresForStops({ stopIds: ["A2"], now: NOW }),
      ]);
      expect(fetchRtTileMock).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(t0 + RT_TILE_REUSE_MS - 1);
      await departuresForStop({ stopId: "A2", now: NOW });
      expect(fetchRtTileMock).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(t0 + RT_TILE_REUSE_MS);
      const r = await departuresForStop({ stopId: "A1", now: NOW });
      expect(fetchRtTileMock).toHaveBeenCalledTimes(2);
      expect(r.state).toBe("ok");
    });

    it("keeps one rt-tile per tile for a whole batch, even one that outlasts RT_TILE_REUSE_MS", async () => {
      const { departuresForStops, RT_TILE_REUSE_MS } =
        await loadAt((s) => s.setState({ level: "standard", overrides: {} }));
      await seedTwoStopsInOneTile();
      const t0 = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
      // The second stop's tile read is a slow cold download: by the time it
      // lands, the first stop's rt-tile is past the shared reuse window.
      let reads = 0;
      getDecodedTileMock.mockImplementation(async () => {
        if (++reads === 2) clock.mockReturnValue(t0 + RT_TILE_REUSE_MS + 1);
        return okTile(tileWithStops(["A1", "A2"]));
      });

      const r = await departuresForStops({ stopIds: ["A1", "A2"], now: NOW });

      expect([...r.keys()].sort()).toEqual(["A1", "A2"]);
      expect(reads).toBe(2);
      expect(fetchRtTileMock).toHaveBeenCalledTimes(1);
    });
  });
});


it("isolates late city manifest responses and never reuses another city's ETag", async () => {
  vi.resetModules();
  const read = await import("./scheduleTileReadPath.ts");
  let finishA!: (r: FetchManifestResult) => void;
  fetchManifestMock.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }));
  const a = read.warmManifest();
  city.id = "krakow";
  expect(read.currentManifest()).toBeNull();
  fetchManifestMock.mockResolvedValueOnce(manifestResult("krakow-hash"));
  await read.warmManifest();
  expect(fetchManifestMock.mock.calls[1]?.[0]).toBeUndefined();
  finishA(manifestResult("paris-hash"));
  await a;
  expect(read.currentBundleHash()).toBe("krakow-hash");
  city.id = "paris";
  expect(read.currentBundleHash()).toBe("paris-hash");
  expect(pruneToBundleHashMock).not.toHaveBeenCalled();
});

it("shares simultaneous manifest refreshes for one city", async () => {
  vi.resetModules();
  const read = await import("./scheduleTileReadPath.ts");
  let finish!: (r: FetchManifestResult) => void;
  fetchManifestMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const a = read.warmManifest();
  const b = read.warmManifest();
  expect(fetchManifestMock).toHaveBeenCalledTimes(1);
  finish(manifestResult(HASH));
  await Promise.all([a, b]);
  expect(read.currentBundleHash()).toBe(HASH);
});


it("never uses another city's API coordinate cache for a reused stop ID", async () => {
  vi.resetModules();
  await db.stops.put({id: "reused", cityId: "other-city", name: "Other", location: PARIS, lastSeen: Date.now()});
  const {resolveStopLatLon} = await import("./scheduleTileReadPath.ts");
  expect(await resolveStopLatLon("reused")).toBeNull();
  await db.stops.put({id: "reused", cityId: city.id, name: "Current", location: {lat: 1, lon: 2}, lastSeen: Date.now()});
  expect(await resolveStopLatLon("reused")).toEqual({lat: 1, lon: 2});
});
