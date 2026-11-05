import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFromPtb, buildPtnbStreamedShape } from "./loadFromPtb.js";
import { buildCappedTripStringTable, type GtfsTrip } from "./parser.js";
import { PatternMode } from "@pt/shared";
import type { PtbBundle } from "@pt/shared";

// Fixtures shipped with @pt/shared. `tiny.ptb` is the Rust producer's output
// for crates/pt-producer/tests/fixtures/tiny-gtfs.zip.
const FIXTURE_DIR = fileURLToPath(
  new URL("../../../shared/src/ptb/__fixtures__/", import.meta.url),
);
// Rust-emitted fixtures of specific topologies (the engine corpus directory).
const FRONTEND_FIXTURE_DIR = fileURLToPath(
  new URL("../../../frontend/tests/services/__fixtures__/", import.meta.url),
);

/**
 * Copy a committed `.ptb` into a fresh dir with the minimal sidecars
 * `loadFromPtb` requires. The meta `feedStartDate` is provenance only; the
 * bundle header is the bitmask anchor.
 */
function stageBundle(
  source: string,
  metaFeedStartDate = "2026-05-01",
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ptb-stage-"));
  const p = join(dir, "bundle.ptb");
  copyFileSync(source, p);
  writeFileSync(`${p}.meta.json`, JSON.stringify({
    schemaVersion: 1, producerGitSha: "x", feedStartDate: metaFeedStartDate,
    feeds: [{ url: "file:///x.zip", blobSha256: "0".repeat(64), etag: null }],
  }));
  writeFileSync(`${p}.shapes.json`, JSON.stringify({ schemaVersion: 1, shapes: [] }));
  return { path: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let tmp: string;
let bundlePath: string;

beforeEach(() => {
  vi.stubEnv("PT_FEATURE_SHAPES", "true");
  tmp = mkdtempSync(join(tmpdir(), "loadFromPtb-"));
  bundlePath = join(tmp, "bundle.ptb");
  copyFileSync(join(FIXTURE_DIR, "tiny.ptb"), bundlePath);
  copyFileSync(join(FIXTURE_DIR, "tiny.ptb.meta.json"), `${bundlePath}.meta.json`);
  copyFileSync(join(FIXTURE_DIR, "tiny.ptb.shapes.json"), `${bundlePath}.shapes.json`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadFromPtb — Q1.E zero-network-I/O", () => {
  it("constructs LoadResult from PTB + sidecars without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await loadFromPtb(bundlePath, 0);
    expect(result).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.indexes).toBeDefined();
    expect(result.canonical).toBeDefined();
    expect(result.routingInput).toBeDefined();
  });

  it("populates feedFiles[].blobSha256 from .meta.json", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.feedFiles.length).toBe(1);
    expect(result.feedFiles[0]!.blobSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.feedFiles[0]!.path).toContain("tiny-gtfs.zip");
  });

  it("populates etags Map from .meta.json (preserves weak-ETag form)", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.etags).toBeInstanceOf(Map);
    expect(result.etags.size).toBe(1);
    const [_url, etag] = [...result.etags.entries()][0]!;
    expect(etag).toBe('"W/\\"tiny-fixture-etag\\""');
  });

  it("omits null-ETag feeds from the etags Map", async () => {
    writeFileSync(
      `${bundlePath}.meta.json`,
      JSON.stringify({
        schemaVersion: 1,
        producerGitSha: "test",
        feedStartDate: "2026-01-15",
        feeds: [
          { url: "http://a/feed.zip", blobSha256: "a".repeat(64), etag: null },
          { url: "http://b/feed.zip", blobSha256: "b".repeat(64), etag: "\"b-etag\"" },
        ],
      }),
    );
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.etags.size).toBe(1);
    expect(result.etags.get("http://b/feed.zip")).toBe("\"b-etag\"");
  });

  it("reconstructs all 3 stops with utf-8 names + lat/lon round-trip", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    const collected: string[] = [];
    result.canonical.iterStops((id) => { collected.push(id); });
    expect(collected.sort()).toEqual(["S1", "S2", "S3"]);
    const s1 = result.canonical.getStop("S1");
    expect(s1).toBeDefined();
    expect(s1!.name).toBe("Stop One");
    expect(s1!.lat).toBeCloseTo(54.69, 1);
    expect(s1!.lon).toBeCloseTo(25.28, 1);
  });

  it("reconstructs routes from the PTB routes region", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    const ids: string[] = [];
    result.canonical.iterRoutes((id) => { ids.push(id); });
    expect(ids.sort()).toEqual(["R1", "R2"]);
    expect(result.canonical.getRoute("R1")!.shortName).toBe("1");
    expect(result.canonical.getRoute("R1")!.mode).toBe("BUS");
  });

  it("forwards route_color and route_text_color from the PTB bundle (fixes color regression)", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    const r1 = result.canonical.getRoute("R1")!;
    const r2 = result.canonical.getRoute("R2")!;
    expect(r1.color).toBe("FF0000");
    expect(r1.textColor).toBe("FFFFFF");
    expect(r2.color).toBe("00FF00");
    expect(r2.textColor).toBe("000000");
  });

  it("forwards wheelchairBoarding from PTB stops (S2 = 1)", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    const s2 = result.canonical.getStop("S2")!;
    expect(s2.wheelchairBoarding).toBe(1);
    const s1 = result.canonical.getStop("S1")!;
    expect(s1.wheelchairBoarding).toBe(0);
  });

  it("resolves parent_station from the bundle", async () => {
    // stops.txt: S2 and S3 have parent_station S1 (post-finalize index 0).
    // S1 itself has no parent → empty string.
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.canonical.getStop("S2")!.parentStation).toBe("S1");
    expect(result.canonical.getStop("S3")!.parentStation).toBe("S1");
    expect(result.canonical.getStop("S1")!.parentStation).toBe("");
  });

  it("forwards wheelchairAccessible from PTB trips (T1 = 2)", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    // trips.txt: T1 has wheelchair_accessible=2; GtfsTrip carries it
    // through canonical.getTrip so the serving path (store.ts) can surface it.
    const t1 = result.canonical.getTrip("T1");
    expect(t1).toBeDefined();
    expect(t1!.wheelchairAccessible).toBe(2);
    // T2 has no wheelchair flag set (default 0)
    const t2 = result.canonical.getTrip("T2");
    expect(t2).toBeDefined();
    expect(t2!.wheelchairAccessible).toBe(0);
  });

  it("forwards directionId and shapeId from the PTB trip records", async () => {
    // trips.txt: T1 dir=0/shp_A, T2 dir=1/shp_B — both fields arrive on GtfsTrip.
    const result = await loadFromPtb(bundlePath, 0);
    const t1 = result.canonical.getTrip("T1");
    expect(t1).toBeDefined();
    expect(t1!.directionId).toBe(0);
    expect(t1!.shapeId).toBe("shp_A");
    const t2 = result.canonical.getTrip("T2");
    expect(t2).toBeDefined();
    expect(t2!.directionId).toBe(1);
    expect(t2!.shapeId).toBe("shp_B");
  });

  it("preserves ALL routes from the fixture (multi-route oracle: 2, not 1)", async () => {
    // Regression guard for the bug this whole fix addresses. The old loader
    // GUESSED trip boundaries via a stop_sequence-reset heuristic; when the
    // CSV trip order diverged from the sorted trip_idx order it merged trips
    // and collapsed routes (a real feed served 1 route instead of 116). With
    // the PTB tripStarts[] prefix-sum, every trip's rows are sliced exactly, so the
    // built indexes must carry BOTH fixture routes. The fixture has 2 routes
    // (R1, R2) with trips split across them — assert the count is 2, not 1.
    const result = await loadFromPtb(bundlePath, 0);
    let routeCount = 0;
    result.canonical.iterRoutes(() => { routeCount++; });
    expect(routeCount).toBe(2);
    // And the index-level route_trips must reference both routes' trips, not
    // pile every trip onto one route (the original collapse symptom).
    expect(result.canonical.getRoute("R1")).toBeDefined();
    expect(result.canonical.getRoute("R2")).toBeDefined();
  });

  it("builds per-stop compactStopTimes that hit the fixture's 4 trips", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    // tiny.ptb has 4 trips × 3 stops each — every stop appears in 4 rows.
    const s1 = result.canonical.getCompactStopTimes("S1");
    expect(s1).toBeDefined();
    // 3 trips depart from S1 (T1, T2, T4 — T3 departs from S3 in reverse).
    expect(s1!.departureSecs.length).toBeGreaterThanOrEqual(3);
    // Sorted ascending by departureSecs.
    for (let i = 1; i < s1!.departureSecs.length; i++) {
      expect(s1!.departureSecs[i]!).toBeGreaterThanOrEqual(s1!.departureSecs[i - 1]!);
    }
  });

  it("populates serviceBitmasks from PTB region (keyed by synthesised svc:{idx})", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    // identity.bitmasks exposed via the indexes.identity field
    const bm0 = result.indexes.identity.bitmasks.get("svc:0");
    const bm1 = result.indexes.identity.bitmasks.get("svc:1");
    expect(bm0).toBeDefined();
    expect(bm1).toBeDefined();
    // Day 0 is Friday 20260501. svc:0 (SA) runs Saturdays: byte 0 = day 1 only.
    // svc:1 (WD) runs weekdays: days 0 and 3..7 → 0b1111_1001.
    expect(bm0!.bits[0]).toBe(0x02);
    expect(bm1!.bits[0]).toBe(0xf9);
    // The producer derives the window from calendar.txt (end 20260801) plus
    // its margin: 106 days → 14 bytes.
    expect(bm0!.horizonDays).toBe(106);
    expect(bm0!.bits.byteLength).toBe(14);
  });

  it("expands service bitmasks into calendar_dates so services resolve as active", async () => {
    // Regression: the serving path (store.ts getActiveServiceIdsForDate,
    // buildTileForCell, frontend resolveActiveServices) reads service activity
    // from the canonical/exported calendar, NOT identity.bitmasks. With empty
    // calendar rows every service was inactive everywhere. We now materialise
    // each active bitmask day as an exceptionType=1 ("added") row.
    const result = await loadFromPtb(bundlePath, 0);
    const svc0 = result.canonical.getService("svc:0");
    expect(svc0).toBeDefined();
    // svc:0 (SA) runs Saturdays; the anchor is 2026-05-01 (the bundle header
    // feedStartDate), a Friday.
    expect(svc0!.exceptions.get("20260502")).toBe(1);
    expect(svc0!.exceptions.get("20260509")).toBe(1);
    expect(svc0!.exceptions.has("20260501")).toBe(false);
    // Every materialised exception is an addition (calendar_dates type 1).
    for (const exType of svc0!.exceptions.values()) expect(exType).toBe(1);
    // A bitmask with set bits must produce at least one active date.
    expect(svc0!.exceptions.size).toBeGreaterThan(0);
  });

  it("respects PT_FEATURE_SHAPES=false (omits shapes from result)", async () => {
    vi.stubEnv("PT_FEATURE_SHAPES", "false");
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.shapes).toBeUndefined();
    expect(result.shapePoints).toBeUndefined();
  });

  it("emits a non-empty shapes array when the sidecar carries shapes", async () => {
    writeFileSync(
      `${bundlePath}.shapes.json`,
      JSON.stringify({
        schemaVersion: 1,
        shapes: [
          {
            shapeId: "SHP_1",
            points: [
              { lat: 54.69, lon: 25.28 },
              { lat: 54.70, lon: 25.29 },
              { lat: 54.71, lon: 25.30 },
            ],
            tripRefCount: 1,
          },
        ],
      }),
    );
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.shapes!.length).toBe(1);
    expect(result.shapes![0]!.shapeId).toBe("SHP_1");
    expect(result.shapes![0]!.encodedPolyline.length).toBeGreaterThan(0);
    expect(result.droppedShapes).toBe(0);
  });

  it("drops orphan shapes (tripRefCount 0) and orders survivors by ref count", async () => {
    // Mirrors the Node buildShapesIndex contract: a shape referenced by no
    // trip is filtered (NOT counted as dropped), and survivors are ordered by
    // descending ref count, then shapeId. ORPHAN must vanish; HOT (refs 5)
    // must precede COLD (refs 1) despite sorting after it alphabetically.
    const pts = [
      { lat: 54.69, lon: 25.28 },
      { lat: 54.70, lon: 25.29 },
    ];
    writeFileSync(
      `${bundlePath}.shapes.json`,
      JSON.stringify({
        schemaVersion: 1,
        shapes: [
          { shapeId: "COLD", points: pts, tripRefCount: 1 },
          { shapeId: "HOT", points: pts, tripRefCount: 5 },
          { shapeId: "ORPHAN", points: pts, tripRefCount: 0 },
        ],
      }),
    );
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.shapes!.map((s) => s.shapeId)).toEqual(["HOT", "COLD"]);
    expect(result.droppedShapes).toBe(0);
  });
});

describe("loadFromPtb — calendarDates + horizon follow runtime windowDays", () => {
  // window400.ptb is a real producer-emitted 400-day fixture (windowDays=400,
  // stride 50, feedStartDate=20260619, numServices=2). It carries NO adjacent
  // .meta.json/.shapes.json sidecars in __fixtures__, so we copy the bundle to a
  // tmp dir and write minimal sidecars (the meta feedStartDate is provenance-only;
  // the bundle HEADER is the bitmask anchor SoT). The synth must span the FULL
  // 400-day window — under the old hardcoded 90 only the first-90 active days
  // would materialise (svc:0 → 13 rows instead of its true 56).
  //
  // Dates/counts computed against the feed-tz-agnostic bitmask window; run under
  // TZ=UTC so the addDaysYYYYMMDD (local-time) arithmetic is stable on the
  // UTC+3 dev box vs UTC CI.
  const W400_FIXTURE = fileURLToPath(
    new URL("../../../shared/src/ptb/__fixtures__/window400.ptb", import.meta.url),
  );

  let wdir: string;
  let wpath: string;

  beforeEach(() => {
    wdir = mkdtempSync(join(tmpdir(), "loadFromPtb-w400-"));
    wpath = join(wdir, "bundle.ptb");
    copyFileSync(W400_FIXTURE, wpath);
    writeFileSync(`${wpath}.meta.json`, JSON.stringify({
      schemaVersion: 1, producerGitSha: "w400", feedStartDate: "2026-06-19",
      feeds: [{ url: "file:///w400.zip", blobSha256: "0".repeat(64), etag: null }],
    }));
    writeFileSync(`${wpath}.shapes.json`, JSON.stringify({ schemaVersion: 1, shapes: [] }));
  });

  afterEach(() => {
    rmSync(wdir, { recursive: true, force: true });
  });

  it("reports horizonDays === windowDays (400, not the hardcoded 90)", async () => {
    const result = await loadFromPtb(wpath, 0);
    expect(result.indexes.identity.horizonDays).toBe(400);
    // Per-service bitmask carries the same runtime horizon.
    expect(result.indexes.identity.bitmasks.get("svc:0")!.horizonDays).toBe(400);
    expect(result.indexes.identity.bitmasks.get("svc:1")!.horizonDays).toBe(400);
  });

  it("synthesises calendar_dates ADD rows across the FULL 400-day window", async () => {
    const result = await loadFromPtb(wpath, 0);
    const svc0 = result.canonical.getService("svc:0")!;
    const svc1 = result.canonical.getService("svc:1")!;
    expect(svc0).toBeDefined();
    expect(svc1).toBeDefined();
    // window400.ptb svc:0 has 56 active days over the full 400-day window (only
    // 13 fall inside the first 90 days). The synth must follow header.windowDays,
    // so the materialised exception count is 56 — proving days 90..399 are NOT
    // silently dropped. svc:1 has 276 active days over the full window.
    expect(svc0.exceptions.size).toBe(56);
    expect(svc1.exceptions.size).toBe(276);
    // Every materialised exception is an addition (calendar_dates type 1).
    for (const exType of svc0.exceptions.values()) expect(exType).toBe(1);
    // At least one active day lies BEYOND the first 90 (the migration's point):
    // svc:0's last active window-day is day 386 → 2026-06-19 + 386 days.
    const beyond90 = [...svc0.exceptions.keys()].filter((d) => Number(d) > 20260916);
    expect(beyond90.length).toBeGreaterThan(0);
  });
});

describe("loadFromPtb — direction_id sentinel behaviour", () => {
  it("R1 (T1 dir=0, T2 dir=1) produces two distinct directionPatterns", async () => {
    // The tiny fixture has T1 (dir=0) and T2 (dir=1) both on R1 with an empty headsign. Without the
    // direction_id fix they would share the composite key "" and merge into a single pattern.
    const result = await loadFromPtb(bundlePath, 0);
    const r1Data = result.routingInput.routes.find((r) => r.routeId === "R1");
    expect(r1Data).toBeDefined();
    expect(r1Data!.directionPatterns).toBeDefined();
    const patterns = r1Data!.directionPatterns!;
    expect(patterns.length).toBe(2);
    // The two patterns must carry distinct keys (one for each direction).
    const keys = patterns.map((p) => p.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("trips with directionId=255 (absent sentinel) map to GtfsTrip.directionId===undefined", async () => {
    // canary-gtfs has no direction_id, so the Rust producer writes the 0xFF
    // sentinel for both trips; synthTrips must forward that as undefined so
    // headsign-only bucketing applies.
    const { path, cleanup } = stageBundle(join(FIXTURE_DIR, "canary.ptb"));
    const result = await loadFromPtb(path, 0);
    cleanup();

    // Sentinel byte 255 must map to undefined on GtfsTrip.directionId.
    const t1 = result.canonical.getTrip("tŠ-1");
    expect(t1).toBeDefined();
    expect(t1!.directionId).toBeUndefined();

    // Absent shapeId (empty string in PTB) must map to undefined on GtfsTrip.shapeId.
    // synthTrips: `t.shapeId || undefined` converts "" → undefined.
    expect(t1!.shapeId).toBeUndefined();

    // Two trips with absent direction + same headsign → ONE directionPattern (headsign-only bucket).
    const routeData = result.routingInput.routes.find((r) => r.routeId === "Š1");
    expect(routeData).toBeDefined();
    expect(routeData!.directionPatterns).toBeDefined();
    expect(routeData!.directionPatterns!.length).toBe(1);
  });
});

describe("loadFromPtb — empty optional fields", () => {
  it("decodes empty routeColor and routeTextColor as empty strings on GtfsRoute", async () => {
    // branch-pattern.ptb's route R has no colour set (pool index 0 → "") and
    // must arrive on the canonical route as color="" and textColor="", not undefined.
    const { path, cleanup } = stageBundle(join(FRONTEND_FIXTURE_DIR, "branch-pattern.ptb"));
    const result = await loadFromPtb(path, 0);
    cleanup();
    const route = result.canonical.getRoute("R");
    expect(route).toBeDefined();
    expect(route!.color).toBe("");
    expect(route!.textColor).toBe("");
  });
});

describe("loadFromPtb — error paths", () => {
  it("throws when the bundle file is missing", async () => {
    await expect(loadFromPtb(join(tmp, "nope.ptb"), 0)).rejects.toThrow();
  });

  it("throws when .meta.json sidecar is missing", async () => {
    rmSync(`${bundlePath}.meta.json`);
    await expect(loadFromPtb(bundlePath, 0)).rejects.toThrow(/sidecar missing/);
  });

  it("throws when .shapes.json sidecar is missing", async () => {
    rmSync(`${bundlePath}.shapes.json`);
    await expect(loadFromPtb(bundlePath, 0)).rejects.toThrow(/sidecar missing/);
  });

  it("throws when the bundle magic is bad", async () => {
    writeFileSync(bundlePath, Buffer.alloc(4096));
    await expect(loadFromPtb(bundlePath, 0)).rejects.toThrow(/bad magic/);
  });

  it("throws on schemaVersion mismatch in .meta.json", async () => {
    writeFileSync(
      `${bundlePath}.meta.json`,
      JSON.stringify({ schemaVersion: 99, producerGitSha: "x", feedStartDate: "2026-01-15", feeds: [] }),
    );
    await expect(loadFromPtb(bundlePath, 0)).rejects.toThrow(/schemaVersion/);
  });
});

describe("loadFromPtb — service-bitmask anchor", () => {
  it("uses the bundle header feedStartDate (not meta.json ISO string) as bitmask startDateIso", async () => {
    // tiny.ptb's header feedStartDate is 20260501; the meta.json below uses a
    // deliberately different date that must NOT become the anchor.
    const { path, cleanup } = stageBundle(join(FIXTURE_DIR, "tiny.ptb"), "2025-07-04");
    const result = await loadFromPtb(path, 0);
    cleanup();
    const bm = result.indexes.identity.bitmasks.get("svc:0");
    expect(bm).toBeDefined();
    expect(bm!.startDateIso).toBe("2026-05-01");
  });
});

// ---------------------------------------------------------------------------
// GTFS transfers.txt carriage (PTB Transfers region)
// https://gtfs.org/documentation/schedule/reference/#transferstxt
// ---------------------------------------------------------------------------

describe("loadFromPtb — transfers carriage", () => {
  it("committed tiny.ptb (no transfers.txt) yields transfers: []", async () => {
    const result = await loadFromPtb(bundlePath, 0);
    expect(result.transfers).toEqual([]);
  });

  it("decodes the Transfers region back to the string-id GtfsTransfer shape", async () => {
    // Row 0: route-scoped type 1 (s1,s1, R0→R1); row 1: trip-scoped type 3
    // (s1,s1, T0→T1).
    const scoped = stageBundle(join(FRONTEND_FIXTURE_DIR, "transfer-scoped-trip-beats-route.ptb"));
    const scopedResult = await loadFromPtb(scoped.path, 0);
    scoped.cleanup();
    expect(scopedResult.transfers).toEqual([
      {
        fromStopId: "s1",
        toStopId: "s1",
        transferType: 1,
        minTransferSecs: undefined,
        fromRouteId: "R0",
        toRouteId: "R1",
        fromTripId: undefined,
        toTripId: undefined,
      },
      {
        fromStopId: "s1",
        toStopId: "s1",
        transferType: 3,
        minTransferSecs: undefined,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: "T0",
        toTripId: "T1",
      },
    ]);

    // An unscoped type 2 row with min_transfer_time.
    const minTime = stageBundle(join(FRONTEND_FIXTURE_DIR, "transfer-mintime-feasible.ptb"));
    const minTimeResult = await loadFromPtb(minTime.path, 0);
    minTime.cleanup();
    expect(minTimeResult.transfers).toEqual([
      {
        fromStopId: "s1",
        toStopId: "s1",
        transferType: 2,
        minTransferSecs: 300,
        fromRouteId: undefined,
        toRouteId: undefined,
        fromTripId: undefined,
        toTripId: undefined,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scale-guard: shared-prefix ids (the Vilnius collapse scenario)
// ---------------------------------------------------------------------------

describe("loadFromPtb — scale guard (shared-prefix id collision)", () => {
  // shared-prefix-ids.ptb: 50 routes `vilnius_0000..0049`, 6 trips each,
  // trip ids `A1-01-1-2512-00000..00299`.
  it("scale guard: shared-prefix ids preserve all routes AND correct attribution", async () => {
    const { path, cleanup } = stageBundle(join(FRONTEND_FIXTURE_DIR, "shared-prefix-ids.ptb"));
    const result = await loadFromPtb(path, 0);
    cleanup();
    let routeCount = 0;
    result.canonical.iterRoutes(() => { routeCount++; });
    expect(routeCount).toBe(50); // NOT 1 — the fixed-width-id collapse

    // Attribution: each route owns exactly its own 6 trips, and the trip sets
    // are disjoint (a truncated-id key would give every route the same trip).
    const allTripIds: string[] = [];
    for (let n = 0; n < 50; n++) {
      const rid = `vilnius_${String(n).padStart(4, "0")}`;
      expect(result.canonical.getRoute(rid)).toBeDefined();
      const routeData = result.routingInput.routes.find((r) => r.routeId === rid);
      expect(routeData).toBeDefined();
      const ids = routeData!.trips.map((t) => t.tripId).sort();
      const want = Array.from(
        { length: 6 },
        (_, k) => `A1-01-1-2512-${String(n * 6 + k).padStart(5, "0")}`,
      );
      expect(ids).toEqual(want);
      allTripIds.push(...ids);
    }
    expect(new Set(allTripIds).size).toBe(300);
  });

  it("leaves PTB v2 quarantined frequency trips out of the routing input", async () => {
    // tiny-v2.ptb quarantines T5 (see packages/shared/src/ptb/loaderV2.test.ts).
    const { path, cleanup } = stageBundle(join(FIXTURE_DIR, "tiny-v2.ptb"));
    const result = await loadFromPtb(path, 0);
    cleanup();
    const tripIds = result.routingInput.routes.flatMap((r) => r.trips.map((t) => t.tripId));
    expect(tripIds).toContain("T4");
    expect(tripIds).not.toContain("T5");
  });

  it("documents the fixed-width id collision the scale guard defends against", () => {
    const routeIds = ["vilnius_0000", "vilnius_0001", "vilnius_0002"];
    const tripIds = Array.from({ length: 6 }, (_, n) => `A1-01-1-2512-${String(n).padStart(5, "0")}`);
    const truncRoute = (s: string) => s.slice(0, 8);  // old ROUTE_ID_LEN
    const truncTrip = (s: string) => s.slice(0, 12);  // old TRIP_ID_LEN
    expect(new Set(routeIds.map(truncRoute)).size).toBe(1); // collapse 3→1
    expect(new Set(tripIds.map(truncTrip)).size).toBe(1);   // collapse 6→1
  });
});

describe("loadFromPtb — lasso / loop route alignment", () => {
  // The backend PTB sidecar path (buildPtnbStreamedShape) is the production
  // reader the GTFS-zip path is replaced by at boot. No CI gate links it to the
  // shared wire adapter (ptbToBundleWire.ts) or the Rust engine, so a
  // repeated-stop trip must be exercised here directly. GTFS best-practices
  // #lasso-routes: a lasso is ONE trip whose stop_times revisits a stop.
  const SENTINEL = 0xffffffff;

  it("serves BOTH legs of a lasso trip (outbound stem is not collapsed onto the return)", async () => {
    // lasso.ptb: route R, trip T0 over s0→s1→s2→s3→s4→s2→s1→s0 at 0..420.
    const { path, cleanup } = stageBundle(join(FRONTEND_FIXTURE_DIR, "lasso.ptb"));
    const result = await loadFromPtb(path, 0);
    cleanup();
    const data = result.routingInput.routes.find((r) => r.routeId === "R")!;
    expect(data.stopIds).toEqual(["s0", "s1", "s2", "s3", "s4", "s2", "s1", "s0"]);
    // Under a last-write-wins map the outbound stem (positions 0,1,2) would be
    // SENTINEL; the per-trip cursor serves both legs in stop_seq order.
    expect(Array.from(data.trips[0]!.departureSecs)).toEqual([0, 60, 120, 180, 240, 300, 360, 420]);
  });

  it("a present-but-not-served occurrence consumes its slot (served repeat stays on the return position)", async () => {
    // lasso-unserved-occurrence.ptb: the same loop on route R1, but the OUTBOUND
    // s1 (position 1) is present-but-not-served; the RETURN s1 (position 6) is
    // served at 360. The cursor must consume the not-served slot so 360 lands
    // on position 6, NOT collapse onto position 1. This is the slot-consumption
    // invariant the PTB paths (loadFromPtb / ptbToBundleWire / Rust index.rs)
    // all rely on.
    const { path, cleanup } = stageBundle(join(FRONTEND_FIXTURE_DIR, "lasso-unserved-occurrence.ptb"));
    const result = await loadFromPtb(path, 0);
    cleanup();
    const data = result.routingInput.routes.find((r) => r.routeId === "R1")!;
    const dep = Array.from(data.trips[0]!.departureSecs);
    expect(dep[1]).toBe(SENTINEL); // outbound s1 slot consumed, left unserved
    expect(dep[6]).toBe(360); // served return s1 stays on the return position
    expect(dep).toEqual([0, SENTINEL, 120, 180, 240, 300, 360, 420]);
  });
});

// ---------------------------------------------------------------------------
// PatternMode awareness on the PTB boot path
// ---------------------------------------------------------------------------

describe("loadFromPtb — PatternMode (Unbounded vs Off)", () => {
  // branch-pattern.ptb: one route R with two trips on different stop sequences:
  //   T0 (local):  s0 → s1 → s2 → s4
  //   T1 (branch): s0 → s1 → s3 → s4  (branch stop s3)
  // Under Off:       routeTrips has 1 record for R (canonical: the first longest trip).
  // Under Unbounded: routeTrips has 2 records for R (one per pattern).
  async function loadBranch(mode: "off" | "unbounded") {
    const { path, cleanup } = stageBundle(join(FRONTEND_FIXTURE_DIR, "branch-pattern.ptb"));
    vi.stubEnv("PT_PATTERN_MODE", mode);
    const result = await loadFromPtb(path, 0);
    vi.unstubAllEnvs();
    cleanup();
    return result.routingInput.routes.filter((r) => r.routeId === "R");
  }

  it("Off mode: emits a single canonical record per route_id (pre-pattern behaviour)", async () => {
    const records = await loadBranch("off");
    // Off → exactly one record for R, derived from the first longest trip (T0).
    expect(records.length).toBe(1);
    expect(records[0]!.stopIds).toEqual(["s0", "s1", "s2", "s4"]);
    // Both trips are present in the single record.
    expect(records[0]!.trips.length).toBe(2);
    expect(records[0]!.trips.map((t) => t.tripId).sort()).toEqual(["T0", "T1"]);
  });

  it("Unbounded mode: emits TWO records for R (one per stop-sequence pattern)", async () => {
    const records = await loadBranch("unbounded");
    expect(records.length).toBe(2);
    expect(records.every((r) => r.routeId === "R")).toBe(true);
  });

  it("Unbounded mode: branch stop s3 is present in at least one pattern's stopIds", async () => {
    const records = await loadBranch("unbounded");
    // Otherwise the branch stop would be unroutable via the PTB boot path.
    expect(records.some((r) => r.stopIds.includes("s3"))).toBe(true);
  });

  it("Unbounded mode: each trip belongs to exactly one pattern record", async () => {
    const records = await loadBranch("unbounded");
    expect(records.filter((r) => r.trips.some((t) => t.tripId === "T0")).length).toBe(1);
    expect(records.filter((r) => r.trips.some((t) => t.tripId === "T1")).length).toBe(1);
  });

  // CoveringMerge over a REPEATING-stop covering pattern (loop/lasso).
  // covering-loop.ptb: route RL; the covering trip TC visits Y twice
  // (X→Y→Z→Y→W); the folded short trip TF's served sequence (Z→Y→W) is a
  // contiguous run of TC's starting at offset 2. The folded member MUST be
  // placed positionally at window [offset, offset+len) — a from-position-0
  // cursor would re-seek TF's Y to the FIRST Y (position 1) and mis-place the
  // whole fold.
  it("CoveringMerge mode: folded trip's rows honor offset (window holes on a repeated-stop covering pattern)", async () => {
    const SENTINEL = 0xffffffff;
    const { path, cleanup } = stageBundle(join(FRONTEND_FIXTURE_DIR, "covering-loop.ptb"));
    vi.stubEnv("PT_PATTERN_MODE", "covering-merge");
    const result = await loadFromPtb(path, 0);
    vi.unstubAllEnvs();
    cleanup();
    const rlRecords = result.routingInput.routes.filter((r) => r.routeId === "RL");

    // The fold collapses both trips into the single covering pattern.
    expect(rlRecords.length).toBe(1);
    const cover = rlRecords[0]!;
    expect(cover.stopIds).toEqual(["X", "Y", "Z", "Y", "W"]);

    const tf = cover.trips.find((t) => t.tripId === "TF")!;
    const dep = Array.from(tf.departureSecs);
    // Positions 0 (X) and 1 (first Y) are NOT served by TF — sentinel holes.
    expect(dep[0]).toBe(SENTINEL); // X
    expect(dep[1]).toBe(SENTINEL); // first Y
    expect(dep[2]).toBe(50000);    // Z
    expect(dep[3]).toBe(50600);    // second Y (served)
    expect(dep[4]).toBe(51200);    // W
  });
});

describe("buildPtnbStreamedShape — boarding byte + dwell decode (fixture-inexpressible)", () => {
  // The boarding decode (`b & 0b11` / `(b>>2)&0b11`) and the arrDiff→dwell
  // fill are exercised here against a hand-built PtbBundle, so one trip can
  // carry both at chosen positions.
  // Guards the Phase-1b refactor that relocated both into the single pass.
  function bundle(boarding: Uint8Array | undefined): PtbBundle {
    // 1 route (R1), 1 trip (T1), 3 stop_times in stopSeq order:
    //   s0 dep 100 arrDiff 0   stopSeq 1
    //   s1 dep 200 arrDiff -30 stopSeq 2  (30s dwell)
    //   s2 dep 300 arrDiff 0   stopSeq 3
    return {
      stops: [
        { stopId: "s0", stopName: "S0", stopLat: 0, stopLon: 0, wheelchairBoarding: 0 },
        { stopId: "s1", stopName: "S1", stopLat: 0, stopLon: 0, wheelchairBoarding: 0 },
        { stopId: "s2", stopName: "S2", stopLat: 0, stopLon: 0, wheelchairBoarding: 0 },
      ],
      stopTimes: [
        { depSecs: 100, arrDiff: 0, stopIdx: 0, stopSeq: 1 },
        { depSecs: 200, arrDiff: -30, stopIdx: 1, stopSeq: 2 },
        { depSecs: 300, arrDiff: 0, stopIdx: 2, stopSeq: 3 },
      ],
      tripStarts: [0, 3],
      boarding,
    } as unknown as PtbBundle;
  }

  const trips: GtfsTrip[] = [
    { tripId: "T1", routeId: "R1", serviceId: "svc:0", headsign: "H", directionId: 0 },
  ];

  function run(boarding: Uint8Array | undefined, mode: PatternMode) {
    const tripStrings = buildCappedTripStringTable(["T1"], 100);
    const shape = buildPtnbStreamedShape(bundle(boarding), trips, tripStrings, mode);
    const r1 = shape.routeTrips.find((r) => r.routeId === "R1")!;
    expect(r1.stopIds).toEqual(["s0", "s1", "s2"]);
    return { trip: r1.trips.find((t) => t.tripId === "T1")!, shape };
  }

  // Exercises BOTH per-trip fill code paths: the Off branch's `tripsOut` fill and
  // the Unbounded/CoveringMerge branch's native-cursor fill (a single-pattern route
  // still routes through the Unbounded branch under those modes).
  it.each([PatternMode.Off, PatternMode.Unbounded, PatternMode.CoveringMerge])(
    "decodes pickup/drop_off types and dwell at the right canonical positions (mode=%s)",
    (mode) => {
      // boarding: row1 byte 0x09 = pickup_type 1 (0b01), drop_off_type 2 (0b10).
      // rows 0 and 2 default 0x50 → pickup 0 / drop_off 0.
      const { trip: t, shape } = run(new Uint8Array([0x50, 0x09, 0x50]), mode);
      expect(Array.from(t.departureSecs)).toEqual([100, 200, 300]);
      // arrDiff -30 on row1 → 30s dwell at position 1, others 0.
      expect(t.dwellSecs).toBeDefined();
      expect(Array.from(t.dwellSecs!)).toEqual([0, 30, 0]);
      expect(t.pickupTypes).toBeDefined();
      expect(Array.from(t.pickupTypes!)).toEqual([0, 1, 0]);
      expect(t.dropOffTypes).toBeDefined();
      expect(Array.from(t.dropOffTypes!)).toEqual([0, 2, 0]);
      // Per-stop departure CSR: each stop carries this trip's one departure.
      expect(Array.from(shape.stopTimesIndex.get("s0")!.departureSecs)).toEqual([100]);
      expect(Array.from(shape.stopTimesIndex.get("s1")!.departureSecs)).toEqual([200]);
      expect(Array.from(shape.stopTimesIndex.get("s2")!.departureSecs)).toEqual([300]);
    },
  );

  it("omits pickupTypes/dropOffTypes when boarding region is absent (all-default)", () => {
    const { trip: t } = run(undefined, PatternMode.Off);
    // arrDiff -30 still yields a dwell array; boarding defaults to 0x50 ⇒ all
    // pickup/drop_off types 0 ⇒ the sparse arrays are omitted entirely.
    expect(Array.from(t.dwellSecs!)).toEqual([0, 30, 0]);
    expect(t.pickupTypes).toBeUndefined();
    expect(t.dropOffTypes).toBeUndefined();
  });

  it("skips MISSING_DEP rows from the per-stop CSR but keeps the canonical slot as a sentinel", () => {
    const SENTINEL = 0xffffffff;
    // Same 3-stop trip, but s1's departure is the missing-departure sentinel.
    const ptnb = {
      stops: [
        { stopId: "s0", stopName: "S0", stopLat: 0, stopLon: 0, wheelchairBoarding: 0 },
        { stopId: "s1", stopName: "S1", stopLat: 0, stopLon: 0, wheelchairBoarding: 0 },
        { stopId: "s2", stopName: "S2", stopLat: 0, stopLon: 0, wheelchairBoarding: 0 },
      ],
      stopTimes: [
        { depSecs: 100, arrDiff: 0, stopIdx: 0, stopSeq: 1 },
        { depSecs: SENTINEL, arrDiff: 0, stopIdx: 1, stopSeq: 2 },
        { depSecs: 300, arrDiff: 0, stopIdx: 2, stopSeq: 3 },
      ],
      tripStarts: [0, 3],
      boarding: undefined,
    } as unknown as PtbBundle;
    const tripStrings = buildCappedTripStringTable(["T1"], 100);
    const shape = buildPtnbStreamedShape(ptnb, trips, tripStrings, PatternMode.Off);
    // s1's MISSING_DEP row never enters the per-stop departure CSR…
    expect(shape.stopTimesIndex.has("s1")).toBe(false);
    expect(Array.from(shape.stopTimesIndex.get("s0")!.departureSecs)).toEqual([100]);
    // …but the canonical stop sequence still includes s1, with its slot left as
    // the UNSERVED sentinel so repeats downstream stay aligned.
    const t = shape.routeTrips.find((r) => r.routeId === "R1")!.trips[0]!;
    expect(Array.from(t.departureSecs)).toEqual([100, SENTINEL, 300]);
  });
});

// NOTE: the B1.5 carry-less band→flat re-materialization is now done by `loadPtb`
// itself (it materializes stopTimes/tripStarts/boarding from the pattern band
// when the flat carry is absent/empty), so there is no longer a backend-side
// `applyBandToFlatCarry` shim to test here. The decoder's equivalence to the flat
// carry — and the carry-less loadPtb path — are covered by the shared suites
// `packages/shared/src/ptb/bandToFlatStopTimes.test.ts` and `bandCarryless.test.ts`.

// --------------------------------------------------------------------------- 0x17 Frequencies
// region — lossless re-emit via loadFromPtb
// https://gtfs.org/documentation/schedule/reference/#frequenciestxt
// ---------------------------------------------------------------------------

describe("loadFromPtb — 0x17 Frequencies region lossless re-emit", () => {
  const WITHOUT_FREQUENCIES = fileURLToPath(
    new URL("../../../shared/src/ptb/__fixtures__/tiny-service-pool.ptb", import.meta.url),
  );
  const WITH_FREQUENCIES = fileURLToPath(
    new URL("../../../shared/src/ptb/__fixtures__/frequencies-parity.ptb", import.meta.url),
  );

  /** Write a PTB buffer + minimal sidecars to a temp dir; return cleanup + path. */
  function writeTempBundle(buf: Buffer): { path: string; cleanup: () => void } {
    const d = mkdtempSync(join(tmpdir(), "loadFromPtb-freq-"));
    const p = join(d, "freq.ptb");
    writeFileSync(p, buf);
    writeFileSync(`${p}.meta.json`, JSON.stringify({
      schemaVersion: 1, producerGitSha: "test", feedStartDate: "2026-06-01",
      feeds: [{ url: "file:///test.zip", blobSha256: "0".repeat(64), etag: null }],
    }));
    writeFileSync(`${p}.shapes.json`, JSON.stringify({ schemaVersion: 1, shapes: [] }));
    return { path: p, cleanup: () => rmSync(d, { recursive: true, force: true }) };
  }

  it("exposes frequencies: [] / undefined when the 0x17 region is absent", async () => {
    const { path, cleanup } = writeTempBundle(readFileSync(WITHOUT_FREQUENCIES));
    try {
      const result = await loadFromPtb(path, 0);
      // Absent region → frequencies is undefined or an empty array.
      expect(!result.frequencies || result.frequencies.length === 0).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("re-emits all GtfsFrequency rows, including overnight endSecs > 86400", async () => {
    const { path, cleanup } = writeTempBundle(readFileSync(WITH_FREQUENCIES));
    try {
      const result = await loadFromPtb(path, 0);
      expect(result.frequencies).toEqual([
        { tripId: "", startSecs: 21600, endSecs: 86400, headwaySecs: 600, exactTimes: 0 },
        { tripId: "", startSecs: 86400, endSecs: 108000, headwaySecs: 1800, exactTimes: 1 },
        { tripId: "", startSecs: 36000, endSecs: 72000, headwaySecs: 900, exactTimes: 0 },
      ]);
    } finally {
      cleanup();
    }
  });
});
