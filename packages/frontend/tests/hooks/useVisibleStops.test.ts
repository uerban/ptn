import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { StopWithLines } from "@pt/shared";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

// Hoisted mock handles — each test case resets the selector return values.
const stopStoreState = { stops: [] as StopWithLines[] };
const settingsState = { urbanMode: false, urbanLookaheadHours: 2 };
const gtfsDataState: { raptorIndex: RaptorIndex | null; syncing: boolean } = {
  raptorIndex: null,
  syncing: false,
};
// Feed timezone of the active city — threaded into `stopMaybeActive` as the
// 5th arg so a cross-tz device resolves the feed's wall clock.
const FEED_TZ = "Europe/Vilnius";
const cityState = { activeCity: { tz: FEED_TZ } };

vi.mock("../../src/stores/stopStore.ts", () => ({
  useStopStore: (selector: (s: typeof stopStoreState) => unknown) =>
    selector(stopStoreState),
}));
vi.mock("../../src/stores/settingsStore.ts", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) =>
    selector(settingsState),
}));
vi.mock("../../src/stores/gtfsDataStore.ts", () => ({
  useGtfsDataStore: (selector: (s: typeof gtfsDataState) => unknown) =>
    selector(gtfsDataState),
}));
vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: (selector: (s: typeof cityState) => unknown) =>
    selector(cityState),
}));

import { useVisibleStops } from "../../src/hooks/useVisibleStops.ts";
import { useBadgeActivityStore } from "../../src/stores/badgeActivityStore.ts";

// Stop "S" is return-only for route "R" (present in routesAtStop but NOT on
// route.stopIds), so `stopMaybeActive("S")` is true via the fail-open
// indeterminate branch regardless of departure times. Stop "A" IS canonical
// (on route.stopIds) with its only departure at 05:00 — out of a midday
// window — so `stopMaybeActive("A")` is false. This mirrors the index used by
// `stopMaybeActive.test.ts`.
function index(): RaptorIndex {
  return {
    routesAtStop: new Map([
      ["S", [0]],
      ["A", [0]],
      ["B", [0]],
    ]),
    routes: [
      {
        id: "R",
        shortName: "R",
        mode: "BUS" as const,
        stopIds: ["A", "B"],
        trips: [
          {
            tripId: "t1",
            serviceId: "svc",
            headsign: "H",
            departureSecs: [5 * 3600, 5 * 3600 + 120],
          },
        ],
        directionPatterns: [{ key: "k", headsign: "H2", stopIds: ["S", "A"] }],
      },
    ],
    services: new Map([
      [
        "svc",
        {
          serviceId: "svc",
          startDate: "20260101",
          endDate: "20271231",
          days: [true, true, true, true, true, true, true],
          exceptions: {},
        },
      ],
    ]),
    routeIdToIdx: new Map([["R", 0]]),
  } as unknown as RaptorIndex;
}

// Carded stop "S" with two cached lines. `stopMaybeActive("S")` is true
// (return-only fail-open), so the only question per test is how the badge
// activity store narrows / holds / fails open the line set.
const stopS: StopWithLines = {
  id: "S",
  name: "Carded stop",
  location: { lat: 54.68, lon: 25.28 },
  lines: [
    { routeId: "R1", shortName: "1", mode: "BUS" },
    { routeId: "R2", shortName: "2", mode: "BUS" },
  ],
  lastSeen: 0,
};
// Canonical stop "A" with no in-window departure → `stopMaybeActive("A")`
// is false → dropped from the visible set when urban mode is on.
const stopA: StopWithLines = {
  id: "A",
  name: "Canonical out-of-window stop",
  location: { lat: 54.69, lon: 25.29 },
  lines: [{ routeId: "R-A", shortName: "A", mode: "BUS" }],
  lastSeen: 0,
};
const fakeIndex = {} as unknown as RaptorIndex;

describe("useVisibleStops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin the clock: useVisibleStops derives `now` from Date.now() (minuteBucket),
    // and we use the REAL stopMaybeActive. Without this, stop "A"'s 05:00
    // departure falls inside the 2h window when the suite runs 03:00–05:00
    // feed-time, flaking the "dropped" assertion. Noon UTC = 15:00 Vilnius.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
    useBadgeActivityStore.getState().clear();
    stopStoreState.stops = [stopS];
    settingsState.urbanMode = false;
    settingsState.urbanLookaheadHours = 2;
    gtfsDataState.raptorIndex = null;
    gtfsDataState.syncing = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns all stops when urban mode is off", () => {
    settingsState.urbanMode = false;
    gtfsDataState.raptorIndex = fakeIndex;
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current).toEqual([stopS]);
  });

  it("returns all stops when urban mode is on but raptor index is not loaded (fails open)", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = null;
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current).toEqual([stopS]);
  });

  it("returns all stops when urban mode is on but gtfs is still syncing", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = fakeIndex;
    gtfsDataState.syncing = true;
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current).toEqual([stopS]);
  });

  it("drops a stop with no in-window departure (stopMaybeActive false)", () => {
    // "A" is canonical with its only departure at 05:00; a midday `now` puts
    // it out of window, and it is not return-only, so it is filtered out.
    stopStoreState.stops = [stopA, stopS];
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current.map((s) => s.id)).toEqual(["S"]);
  });

  it("narrows badges to the tile-active set when available", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set(["R1"]) });
    const { result } = renderHook(() => useVisibleStops());
    const s = result.current.find((x) => x.id === "S")!;
    expect(s.lines!.map((l) => l.routeId)).toEqual(["R1"]);
    // Partial narrowing returns a NEW object (complement of the identity case).
    expect(s).not.toBe(stopS);
    expect(stopS.lines).toHaveLength(2); // original never mutated
  });

  it("fails open to full lines when tile activity is unavailable", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    useBadgeActivityStore.getState().set("S", { state: "unavailable" });
    const { result } = renderHook(() => useVisibleStops());
    const s = result.current.find((x) => x.id === "S")!;
    expect(s.lines!.map((l) => l.routeId)).toEqual(["R1", "R2"]);
  });

  it("fails open to full lines when there is no activity entry", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    const { result } = renderHook(() => useVisibleStops());
    const s = result.current.find((x) => x.id === "S")!;
    expect(s.lines!.map((l) => l.routeId)).toEqual(["R1", "R2"]);
  });

  it("hides a stop the tile confirms is serviceless (ready + empty route set)", () => {
    // Night case: "S" is return-only for "R", so stopMaybeActive("S") fails open
    // to true — but the schedule tile authoritatively reports NO departures
    // (ready + empty). Trust the tile: the stop has no upcoming service, so it
    // must drop out of the urban view entirely (dot + card), not linger as a
    // name-only card. This is the night-clutter regression.
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set() });
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current.map((s) => s.id)).toEqual([]);
  });

  it("hides a no-cached-lines stop the tile confirms is serviceless", () => {
    // Same tile-authoritative hide, but for a stop with no enriched `lines`:
    // the ready+empty check must run before the no-lines short-circuit so a
    // serviceless return-only stop without line metadata still drops out.
    const bare: StopWithLines = {
      id: "S",
      name: "No lines yet",
      location: { lat: 54.71, lon: 25.31 },
      lastSeen: 0,
    };
    stopStoreState.stops = [bare];
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set() });
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current).toEqual([]);
  });

  it("holds badges (empty lines) while loading", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    useBadgeActivityStore.getState().set("S", { state: "loading" });
    const { result } = renderHook(() => useVisibleStops());
    const s = result.current.find((x) => x.id === "S")!;
    expect(s.lines).toEqual([]);
  });

  it("preserves stop identity when the tile-active set covers every cached line", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    useBadgeActivityStore
      .getState()
      .set("S", { state: "ready", routeIds: new Set(["R1", "R2"]) });
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current.find((x) => x.id === "S")).toBe(stopS);
    // The original cached stop must not be mutated.
    expect(stopS.lines).toHaveLength(2);
  });

  it("keeps a stop with no cached lines as-is when it is active", () => {
    const bare: StopWithLines = {
      id: "S",
      name: "No lines yet",
      location: { lat: 54.71, lon: 25.31 },
      lastSeen: 0,
    };
    stopStoreState.stops = [bare];
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = index();
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set(["R1"]) });
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current).toEqual([bare]);
    expect(result.current[0]).toBe(bare);
  });
});

// Pattern-exact index (the production CoveringMerge path) ------------------
//
// When the index carries `patterns`/`patternsAtStop`, departure times are
// readable at every served stop, so `stopMaybeActive` answers EXACTLY and the
// INDEX — not the viewport-transient schedule-tile verdict — is the visibility
// authority. Visibility then cannot depend on zoom level or on which areas
// the user happened to browse at card zoom (the blip regression).
describe("useVisibleStops — pattern-exact index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Same pinned clock as the main suite: noon UTC = 15:00 Europe/Vilnius,
    // so the fixture departure times are deterministic against the real
    // stopMaybeActive (see the note on the main suite's beforeEach).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
    useBadgeActivityStore.getState().clear();
    stopStoreState.stops = [stopS];
    settingsState.urbanMode = false;
    settingsState.urbanLookaheadHours = 2;
    gtfsDataState.raptorIndex = null;
    gtfsDataState.syncing = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Route "R" serves "S" only on its reverse pattern. `revDepartureSecs`
   *  positions the (single) reverse trip; noon fixture clock = 15:00 Vilnius
   *  = 54000 feed secs. */
  function patternIndex(revDepartureSecs: [number, number]): RaptorIndex {
    const fwd = {
      id: "R",
      shortName: "R",
      mode: "BUS" as const,
      stopIds: ["A", "B"],
      trips: [
        { tripId: "t-fwd", serviceId: "svc", headsign: "H", departureSecs: [5 * 3600, 5 * 3600 + 120] },
      ],
    };
    const rev = {
      id: "R",
      shortName: "R",
      mode: "BUS" as const,
      stopIds: ["B-rev", "S"],
      trips: [
        { tripId: "t-rev", serviceId: "svc", headsign: "H2", departureSecs: revDepartureSecs },
      ],
    };
    return {
      routes: [fwd],
      routeIdToIdx: new Map([["R", 0]]),
      routesAtStop: new Map([
        ["A", [0]],
        ["B", [0]],
        ["B-rev", [0]],
        ["S", [0]],
      ]),
      services: new Map([
        [
          "svc",
          {
            serviceId: "svc",
            startDate: "20260101",
            endDate: "20271231",
            days: [true, true, true, true, true, true, true],
            exceptions: {},
          },
        ],
      ]),
      patterns: [fwd, rev],
      patternsAtStop: new Map([
        ["A", [0]],
        ["B", [0]],
        ["B-rev", [1]],
        ["S", [1]],
      ]),
    } as unknown as RaptorIndex;
  }
  // Fixture clock (beforeEach) is 2026-06-16T12:00:00Z = 15:00 Europe/Vilnius.
  const IN_WINDOW: [number, number] = [15 * 3600 + 1800, 15 * 3600 + 2400]; // 15:30 / 15:40
  const OUT_OF_WINDOW: [number, number] = [5 * 3600, 5 * 3600 + 600]; // 05:00 / 05:10

  it("hides a serviceless reverse-only stop WITHOUT any tile verdict (zoom/viewport independence)", () => {
    // The blip regression: below card zoom (or after eviction) there is NO
    // badge-activity entry. The pattern-exact index alone must hide the
    // serviceless stop — visibility may not depend on a tile verdict that
    // only exists for the last card-zoom viewport.
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = patternIndex(OUT_OF_WINDOW);
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current.map((s) => s.id)).toEqual([]);
  });

  it("keeps an active reverse-only stop with full lines when no tile verdict exists (badge fail-open)", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = patternIndex(IN_WINDOW);
    const { result } = renderHook(() => useVisibleStops());
    const s = result.current.find((x) => x.id === "S")!;
    expect(s.lines!.map((l) => l.routeId)).toEqual(["R1", "R2"]);
  });

  it("keeps an index-active stop visible (name-only) when a divergent tile verdict says ready+empty", () => {
    // Index (exact) says the stop has upcoming service; a ready+EMPTY tile
    // verdict can then only be generation skew. Hiding on it would re-create
    // a zoom-coupled blip (visible at label zoom, vanishing at card zoom the
    // moment the verdict lands) — so the stop stays, badges narrow to none.
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = patternIndex(IN_WINDOW);
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set() });
    const { result } = renderHook(() => useVisibleStops());
    const s = result.current.find((x) => x.id === "S")!;
    expect(s.lines).toEqual([]);
  });

  it("narrows badges to a non-empty tile verdict exactly as on the legacy path", () => {
    settingsState.urbanMode = true;
    gtfsDataState.raptorIndex = patternIndex(IN_WINDOW);
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set(["R1"]) });
    const { result } = renderHook(() => useVisibleStops());
    const s = result.current.find((x) => x.id === "S")!;
    expect(s.lines!.map((l) => l.routeId)).toEqual(["R1"]);
  });

  it("still tile-hides a ready+empty stop the patterns do NOT cover (per-route wire shape)", () => {
    // Wire-shape skew belt: patterns exist but only cover canonical
    // sequences (one record per route_id; "S" lives only in
    // directionPatterns). "S" is then undecidable → fail-open keeps it — and
    // the LEGACY tile-authoritative serviceless hide must still apply, or
    // the night map floods for users on a stale cached bundle.
    const fwd = {
      id: "R",
      shortName: "R",
      mode: "BUS" as const,
      stopIds: ["A", "B"],
      trips: [
        { tripId: "t-fwd", serviceId: "svc", headsign: "H", departureSecs: [5 * 3600, 5 * 3600 + 120] },
      ],
      directionPatterns: [{ key: "k", headsign: "H2", stopIds: ["S", "A"] }],
    };
    gtfsDataState.raptorIndex = {
      routes: [fwd],
      routeIdToIdx: new Map([["R", 0]]),
      routesAtStop: new Map([
        ["A", [0]],
        ["B", [0]],
        ["S", [0]],
      ]),
      services: new Map([
        [
          "svc",
          {
            serviceId: "svc",
            startDate: "20260101",
            endDate: "20271231",
            days: [true, true, true, true, true, true, true],
            exceptions: {},
          },
        ],
      ]),
      patterns: [fwd],
      patternsAtStop: new Map([
        ["A", [0]],
        ["B", [0]],
      ]),
    } as unknown as RaptorIndex;
    settingsState.urbanMode = true;
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set() });
    const { result } = renderHook(() => useVisibleStops());
    expect(result.current.map((s) => s.id)).toEqual([]);
  });
});
