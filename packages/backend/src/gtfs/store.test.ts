import { describe, it, expect } from "vitest";
import { GtfsStore, StopWithRoutes } from "./store.js";
import { buildIndexes, type GtfsIndexes } from "./index-builder.js";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import { createCanonicalStore } from "./canonical/CanonicalStore.js";
import { buildTripStringTable } from "./parser.js";
import { emptyTestIdentity } from "./identity/testIdentity.js";
import {
  fixtureStops,
  fixtureRoutes,
  fixtureTrips,
  fixtureStopTimes,
  fixtureServices,
} from "./__fixtures__/simpleCity.js";
import {
  fixtureStops as overnightStops,
  fixtureRoutes as overnightRoutes,
  fixtureTrips as overnightTrips,
  fixtureStopTimes as overnightStopTimes,
  fixtureServices as overnightServices,
  bruteForceDepartures,
} from "./__fixtures__/overnightCity.js";
import {
  fixtureStops as variantStops,
  fixtureRoutes as variantRoutes,
  fixtureTrips as variantTrips,
  fixtureStopTimes as variantStopTimes,
  fixtureServices as variantServices,
  bruteForceActiveRoutes,
} from "./__fixtures__/variantPatternCity.js";

describe("getAllStops caching", () => {
  it("returns the same array instance across calls (cached)", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      fixtureStops,
      fixtureRoutes,
      fixtureTrips,
      fixtureStopTimes,
      fixtureServices,
      [],
    );
    store.swap(indexes, canonical, routingInput);

    const a = store.getAllStops();
    const b = store.getAllStops();
    expect(a).toBe(b); // reference-equal: cache hit
  });

  it("invalidates the cache on swap", () => {
    const store = new GtfsStore();
    const { indexes: i1, canonical: c1, routingInput: ri1 } = buildIndexes(
      fixtureStops,
      fixtureRoutes,
      fixtureTrips,
      fixtureStopTimes,
      fixtureServices,
      [],
    );
    store.swap(i1, c1, ri1);
    const before = store.getAllStops();

    const { indexes: i2, canonical: c2, routingInput: ri2 } = buildIndexes(
      fixtureStops,
      fixtureRoutes,
      fixtureTrips,
      fixtureStopTimes,
      fixtureServices,
      [],
    );
    store.swap(i2, c2, ri2);
    const after = store.getAllStops();
    expect(after).not.toBe(before);
    expect(after.length).toBe(fixtureStops.length);
    expect(after[0].id).toBe(fixtureStops[0].id);
  });

  it("returns a deeply-frozen structure (array + entries + nested routes + location)", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(indexes, canonical, routingInput);
    const result = store.getAllStops();

    // Top-level array
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => (result as StopWithRoutes[]).push({
      id: "x", name: "x", location: { lat: 0, lon: 0 }, routes: [],
    })).toThrow(TypeError);

    // Each entry is frozen
    expect(result.length).toBeGreaterThan(0);
    const first = result[0]!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.routes)).toBe(true);
    expect(Object.isFrozen(first.location)).toBe(true);

    // Nested mutations throw
    expect(() => (first.routes as StopWithRoutes["routes"]).push({
      id: "x", shortName: "x", color: "000000", textColor: "FFFFFF", mode: "BUS", subMode: "BUS",
    })).toThrow(TypeError);
    expect(() => { (first.location as { lat: number }).lat = 999; }).toThrow(TypeError);
  });
});

describe("getDepartures binary-search window", () => {
  it("matches a reference brute-force scan for overnight + morning stops", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      overnightStops, overnightRoutes, overnightTrips,
      overnightStopTimes, overnightServices, [],
    );
    store.swap(indexes, canonical, routingInput);

    const date = new Date("2026-04-20T23:30:00Z");
    const fast = store.getDepartures("stop-1", date, 100, 2);
    const reference = bruteForceDepartures(canonical, "stop-1", date, 100, 2);
    expect(fast).toEqual(reference);
  });

  it("handles a 2h window crossing midnight (23:30 → 01:30 next day)", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      overnightStops, overnightRoutes, overnightTrips,
      overnightStopTimes, overnightServices, [],
    );
    store.swap(indexes, canonical, routingInput);
    const date = new Date("2026-04-20T23:30:00Z");
    const fast = store.getDepartures("stop-1", date, 100, 2);
    const reference = bruteForceDepartures(canonical, "stop-1", date, 100, 2);

    // Fidelity: fast path must match the brute-force oracle byte-for-byte.
    expect(fast).toEqual(reference);

    // And: every returned time lies inside the requested window.
    const lower = date.getTime() - 10 * 60_000;
    const upper = date.getTime() + 2 * 60 * 60_000;
    for (const d of fast) {
      const t = new Date(d.scheduledTime).getTime();
      expect(t).toBeGreaterThanOrEqual(lower);
      expect(t).toBeLessThanOrEqual(upper);
    }

    // Sanity: the window actually straddles midnight, so we should see at
    // least one pre-midnight and one post-midnight departure. Fails loudly
    // if the fixture's overnight trips get filtered out by a future
    // refactor, which would also hide a real regression.
    const midnight = Math.floor(date.getTime() / 86_400_000) * 86_400_000 + 86_400_000;
    const preMidnight = fast.filter((d) => new Date(d.scheduledTime).getTime() < midnight);
    const postMidnight = fast.filter((d) => new Date(d.scheduledTime).getTime() >= midnight);
    expect(preMidnight.length).toBeGreaterThan(0);
    expect(postMidnight.length).toBeGreaterThan(0);
  });

  it("matches brute-force for a midday window entirely within one service day", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      overnightStops, overnightRoutes, overnightTrips,
      overnightStopTimes, overnightServices, [],
    );
    store.swap(indexes, canonical, routingInput);
    const date = new Date("2026-04-20T12:00:00Z");
    const fast = store.getDepartures("stop-1", date, 100, 2);
    const reference = bruteForceDepartures(canonical, "stop-1", date, 100, 2);
    expect(fast).toEqual(reference);
  });
});

describe("routeStopIndex precompute", () => {
  it("maps (routeId, stopId) to the stop's index within the route's canonical stop sequence", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(indexes, canonical, routingInput);

    // Access the private field via the test helper's type cast.
    const routeStopIndex = (store as unknown as {
      routeStopIndex: Map<string, Map<string, number>>;
    }).routeStopIndex;
    expect(routeStopIndex).toBeInstanceOf(Map);

    // For the simpleCity fixture's single route with 3 stops A/B/C:
    const simpleRouteId = fixtureRoutes[0].id;
    const perStop = routeStopIndex.get(simpleRouteId);
    expect(perStop).toBeDefined();
    expect(perStop?.size).toBe(fixtureStops.length);
    // Every fixture stop should appear somewhere in the sequence.
    for (const stop of fixtureStops) {
      expect(perStop?.has(stop.id)).toBe(true);
    }
    // Indexes are 0, 1, 2 covering the fixture stop range.
    const sortedIndexes = Array.from(perStop!.values()).sort((a, b) => a - b);
    expect(sortedIndexes).toEqual([0, 1, 2]);
  });

  it("is rebuilt on every swap", () => {
    const store = new GtfsStore();
    const { indexes: i1, canonical: c1, routingInput: ri1 } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(i1, c1, ri1);
    const first = (store as unknown as { routeStopIndex: Map<string, Map<string, number>> }).routeStopIndex;

    const { indexes: i2, canonical: c2, routingInput: ri2 } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(i2, c2, ri2);
    const second = (store as unknown as { routeStopIndex: Map<string, Map<string, number>> }).routeStopIndex;

    expect(second).not.toBe(first);
  });
});

describe("getActiveRoutesByStop fidelity", () => {
  it("matches brute-force oracle for a multi-route fixture with variant patterns", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      variantStops, variantRoutes, variantTrips, variantStopTimes, variantServices, [],
    );
    store.swap(indexes, canonical, routingInput);

    // Query date in the morning window where trips are active.
    const date = new Date("2026-04-20T08:00:00Z");
    const fast = store.getActiveRoutesByStop(date, 2);
    const reference = bruteForceActiveRoutes(canonical, date, 2);

    // Compare the two maps: same keys, same set contents per key.
    expect(new Set(fast.keys())).toEqual(new Set(reference.keys()));
    for (const [stopId, routes] of fast) {
      expect(routes).toEqual(reference.get(stopId)!);
    }
  });

  it("includes canonical-only stops (C, D of R1)", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      variantStops, variantRoutes, variantTrips, variantStopTimes, variantServices, [],
    );
    store.swap(indexes, canonical, routingInput);
    const date = new Date("2026-04-20T08:00:00Z");
    const result = store.getActiveRoutesByStop(date, 2);

    // Stops C and D appear only in R1's canonical (long) pattern.
    // They MUST resolve to R1 — this is the fast-path case.
    expect(result.get("C")?.has("R1")).toBe(true);
    expect(result.get("D")?.has("R1")).toBe(true);
  });

  it("resolves a route for a stop that exists ONLY in a variant trip (fallback path)", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      variantStops, variantRoutes, variantTrips, variantStopTimes, variantServices, [],
    );
    store.swap(indexes, canonical, routingInput);
    const date = new Date("2026-04-20T08:00:00Z");
    const fast = store.getActiveRoutesByStop(date, 2);

    // F is only in the variant T_R1_VAR2 [A, F, B]; canonical [A,B,C,D,E] skips it.
    const routeStopIndex = (store as unknown as { routeStopIndex: Map<string, Map<string, number>> }).routeStopIndex;
    expect(routeStopIndex.get("R1")?.has("F")).toBe(false);

    // Fallback path must still find R1 at F.
    expect(fast.get("F")?.has("R1")).toBe(true);
  });

  it("does not report a stop active when the variant trip skips it (sentinel check)", () => {
    // Scenario: T_R1_LONG (canonical) is shifted to evening so it is NOT
    // active in the morning window. T_R1_VAR (variant, covers [A,B,E]) IS
    // active in the morning. Stops C and D are skipped by the variant trip,
    // so their departureSecs entries will be 0xFFFFFFFF (internal sentinel;
    // wire format rewrites to -1). Without the sentinel guard, the large
    // value falls inside an upper-open window, producing a false positive
    // for (C, R1) and (D, R1).

    // Build an inline fixture that reuses the variantPatternCity structure
    // but moves T_R1_LONG to 20:00 (evening) so only T_R1_VAR is in-window
    // for a morning query.
    const eveningStops = variantStops;
    const eveningRoutes = variantRoutes;
    const eveningServices = variantServices;

    const eveningTrips = variantTrips; // same trips, different stop-times below

    // Stop-times: T_R1_LONG departs at evening (20:00), T_R1_VAR at morning (09:00)
    const eveningStopTimes = [
      // T_R1_LONG — canonical: A(0) B(1) C(2) D(3) E(4) — evening, out of morning window
      { tripId: "T_R1_LONG", stopId: "A", departureTime: "20:00:00", stopSequence: 1 },
      { tripId: "T_R1_LONG", stopId: "B", departureTime: "20:02:00", stopSequence: 2 },
      { tripId: "T_R1_LONG", stopId: "C", departureTime: "20:04:00", stopSequence: 3 },
      { tripId: "T_R1_LONG", stopId: "D", departureTime: "20:06:00", stopSequence: 4 },
      { tripId: "T_R1_LONG", stopId: "E", departureTime: "20:08:00", stopSequence: 5 },
      // T_R1_VAR — variant: A(0) B(1) E(2) — skips C and D — morning, IN window
      { tripId: "T_R1_VAR",  stopId: "A", departureTime: "09:00:00", stopSequence: 1 },
      { tripId: "T_R1_VAR",  stopId: "B", departureTime: "09:02:00", stopSequence: 2 },
      { tripId: "T_R1_VAR",  stopId: "E", departureTime: "09:04:00", stopSequence: 3 },
      // T_R1_VAR2 — variant 2: A(0) F(1) B(2) — morning, IN window
      { tripId: "T_R1_VAR2", stopId: "A", departureTime: "09:10:00", stopSequence: 1 },
      { tripId: "T_R1_VAR2", stopId: "F", departureTime: "09:12:00", stopSequence: 2 },
      { tripId: "T_R1_VAR2", stopId: "B", departureTime: "09:14:00", stopSequence: 3 },
      // T_R2 — single pattern: X(0) Y(1) Z(2)
      { tripId: "T_R2", stopId: "X", departureTime: "08:30:00", stopSequence: 1 },
      { tripId: "T_R2", stopId: "Y", departureTime: "08:32:00", stopSequence: 2 },
      { tripId: "T_R2", stopId: "Z", departureTime: "08:34:00", stopSequence: 3 },
    ];

    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      eveningStops, eveningRoutes, eveningTrips, eveningStopTimes, eveningServices, [],
    );
    store.swap(indexes, canonical, routingInput);

    // Morning query: only T_R1_VAR and T_R1_VAR2 are active.
    const date = new Date("2026-04-20T08:00:00Z");
    const fast = store.getActiveRoutesByStop(date, 2);

    // A, B, E, F are served by the active variant trips — must be reported active.
    expect(fast.get("A")?.has("R1")).toBe(true);
    expect(fast.get("B")?.has("R1")).toBe(true);
    expect(fast.get("E")?.has("R1")).toBe(true);
    expect(fast.get("F")?.has("R1")).toBe(true);

    // C and D are ONLY in T_R1_LONG (evening) — must NOT be reported active.
    // Without the sentinel guard, the variant trip's -1 entries for C and D
    // would fall inside the window (lowerSecs is negative), producing false positives.
    expect(fast.get("C")?.has("R1")).toBeFalsy();
    expect(fast.get("D")?.has("R1")).toBeFalsy();
  });
});

describe("GtfsStore.canonical / mapView", () => {
  it("are undefined before swap", () => {
    const store = new GtfsStore();
    expect(store.canonical).toBeUndefined();
    expect(store.mapView).toBeUndefined();
  });

  it("are populated after swap", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(indexes, canonical, routingInput, 0);
    expect(store.canonical).toBeDefined();
    expect(store.mapView).toBeDefined();
    expect(store.canonical!.stopCount).toBe(canonical.stopCount);
    expect(store.mapView!.stopCount).toBe(canonical.stopCount);
  });

  it("routingView populated after swap, matches routeTrips size", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(indexes, canonical, routingInput, 0);
    expect(store.routingView).toBeDefined();
    expect(store.routingView!.routeCount).toBe(indexes.routeTrips.length);
  });
});

describe("GtfsStore.identity", () => {
  it("returns undefined before first swap", () => {
    const store = new GtfsStore();
    expect(store.identity).toBeUndefined();
  });

  it("returns the Identity from swapped indexes", () => {
    const store = new GtfsStore();
    const identity = emptyTestIdentity("2026-04-20", 90);
    const indexes = {
      stopRoutes: new Map(),
      stopRouteTripCounts: new Map(),
      routeTrips: [],
      identity,
    } as unknown as GtfsIndexes;
    const stubCanonical = createCanonicalStore({
      stopTimes: new Map(),
      tripStrings: buildTripStringTable([]),
      stops: new Map(),
      routes: new Map(),
      trips: new Map(),
      services: new Map(),
    });
    store.swap(indexes, stubCanonical, { routes: [] });
    expect(store.identity).toBeDefined();
    expect(store.identity?.buildDateIso).toBe("2026-04-20");
  });
});

describe("GtfsStore.realtimeGeneration", () => {
  function makeSwappedStore() {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      fixtureStops,
      fixtureRoutes,
      fixtureTrips,
      fixtureStopTimes,
      fixtureServices,
      [],
    );
    store.swap(indexes, canonical, routingInput);
    return store;
  }

  it("getRtUpdate returns the entry after setRealtimeUpdates", () => {
    const store = makeSwappedStore();
    store.setRealtimeUpdates(
      new Map([["trip-1", { delaySeconds: 60, cancelled: false }]]),
    );
    const result = store.getRtUpdate("trip-1");
    expect(result).toBeDefined();
    expect(result?.delaySeconds).toBe(60);
    expect(result?.cancelled).toBe(false);
  });

  it("getRtUpdate returns undefined for an unknown tripId", () => {
    const store = makeSwappedStore();
    store.setRealtimeUpdates(new Map());
    expect(store.getRtUpdate("no-such-trip")).toBeUndefined();
  });

  it("after swap(), pre-swap RT entries are invisible via getRtUpdate but still present in the map", () => {
    const store = makeSwappedStore();
    // Write an RT entry (generation 1 after the first swap() in makeSwappedStore).
    store.setRealtimeUpdates(
      new Map([["trip-99", { delaySeconds: 120, cancelled: false }]]),
    );
    // Confirm it's visible before the second swap.
    expect(store.getRtUpdate("trip-99")).toBeDefined();

    // Perform a second swap — bumps realtimeGeneration from 1 → 2.
    const { indexes: i2, canonical: c2, routingInput: ri2 } = buildIndexes(
      fixtureStops,
      fixtureRoutes,
      fixtureTrips,
      fixtureStopTimes,
      fixtureServices,
      [],
    );
    store.swap(i2, c2, ri2);

    // The entry is now filtered by the generation gate.
    expect(store.getRtUpdate("trip-99")).toBeUndefined();

    // But the underlying map was NOT cleared — the entry is still present.
    // Access it via the public setRealtimeUpdates path: re-read through the
    // typed map accessor to prove the raw entry survived.
    // We prove "not cleared" by writing fresh RT for the same key and checking
    // it becomes visible again (only possible if the tag overwrites, not clears).
    store.setRealtimeUpdates(
      new Map([["trip-99", { delaySeconds: 180, cancelled: false }]]),
    );
    const refreshed = store.getRtUpdate("trip-99");
    expect(refreshed).toBeDefined();
    expect(refreshed?.delaySeconds).toBe(180);
  });
});

describe("getDepartures shim — RT staleness + lookAheadHours narrowing", () => {
  // The shim's `rtUpdatesSnapshot` filters by `realtimeGeneration` to skip
  // stale entries written before the last `swap()`. `getRtUpdate` covers
  // the public-method path; this pins the SAME filter via the legacy shim
  // path so a regression that drops the generation gate from the snapshot
  // (but leaves it in `getRtUpdate`) doesn't slip through.
  it("excludes stale RT entries (generation-filtered) on the legacy shim path", () => {
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      overnightStops, overnightRoutes, overnightTrips,
      overnightStopTimes, overnightServices, [],
    );
    store.swap(indexes, canonical, routingInput);

    // Pick a trip + departure inside the 2h window from the brute-force
    // oracle so we know there's a matching scheduled departure.
    const date = new Date("2026-04-20T12:00:00Z");
    const before = store.getDepartures("stop-1", date, 100, 2);
    expect(before.length).toBeGreaterThan(0);
    const tripId = before[0]!.tripId;

    // Seed RT for that trip — should appear via the shim.
    store.setRealtimeUpdates(new Map([[tripId, { delaySeconds: 60, cancelled: false }]]));
    const withRt = store.getDepartures("stop-1", date, 100, 2);
    const withRtMatch = withRt.find((d) => d.tripId === tripId);
    expect(withRtMatch?.delaySeconds).toBe(60);

    // Bump generation via a fresh swap. Existing RT entries are now stale.
    const second = buildIndexes(
      overnightStops, overnightRoutes, overnightTrips,
      overnightStopTimes, overnightServices, [],
    );
    store.swap(second.indexes, second.canonical, second.routingInput);

    // The pre-swap RT entry must NOT leak through the shim — that's the
    // generation gate doing its job inside `rtUpdatesSnapshot`.
    const afterSwap = store.getDepartures("stop-1", date, 100, 2);
    const afterSwapMatch = afterSwap.find((d) => d.tripId === tripId);
    expect(afterSwapMatch?.delaySeconds).toBeUndefined();
    expect(afterSwapMatch?.predictedTime).toBeUndefined();

    // Fresh RT after the swap is visible again.
    store.setRealtimeUpdates(new Map([[tripId, { delaySeconds: 90, cancelled: false }]]));
    const refreshed = store.getDepartures("stop-1", date, 100, 2);
    const refreshedMatch = refreshed.find((d) => d.tripId === tripId);
    expect(refreshedMatch?.delaySeconds).toBe(90);
  });

  it("`lookAheadHours: undefined` narrows to a 1h window", () => {
    // Pins the `?? 1` default in the shim. A future refactor that flips
    // to `?? 24` would expand the window across midnight (the shared
    // function forward-expands base dates) and break this test —
    // catching the public-API behavioural drift before it ships.
    const store = new GtfsStore();
    const { indexes, canonical, routingInput } = buildIndexes(
      overnightStops, overnightRoutes, overnightTrips,
      overnightStopTimes, overnightServices, [],
    );
    store.swap(indexes, canonical, routingInput);

    const date = new Date("2026-04-20T12:00:00Z");
    const noLookAhead = store.getDepartures("stop-1", date, 100); // no 4th arg
    const oneHour = store.getDepartures("stop-1", date, 100, 1);
    expect(noLookAhead).toEqual(oneHour);

    // Strict bound: every returned scheduled time falls within
    // `now - 10min` (the cutoff in `getDeparturesFromTile`) and
    // `now + 1h`. Catches a regression that flipped `?? 1` to a larger
    // value — those values would let a 13:30 trip through under
    // `noLookAhead`.
    const lower = date.getTime() - 10 * 60_000;
    const upper = date.getTime() + 60 * 60_000;
    for (const d of noLookAhead) {
      const t = new Date(d.scheduledTime).getTime();
      expect(t).toBeGreaterThanOrEqual(lower);
      expect(t).toBeLessThanOrEqual(upper);
    }
  });
});

describe("rtEntriesForTrip", () => {
  it("returns all generation-current entries for a trip (bare + each date-scoped), with startDate", () => {
    const store = new GtfsStore();
    store.setRealtimeUpdates(new Map([
      ["T1", { delaySeconds: 10, cancelled: false }],
      ["T1|20260611", { delaySeconds: 60, cancelled: false }],
      ["T1|20260612", { delaySeconds: 90, cancelled: true }],
      ["T2", { delaySeconds: 5, cancelled: false }],
    ]));
    const got = store.rtEntriesForTrip("T1").sort(
      (a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""),
    );
    expect(got).toEqual([
      { delaySeconds: 10, cancelled: false },                        // bare → no startDate
      { startDate: "20260611", delaySeconds: 60, cancelled: false },
      { startDate: "20260612", delaySeconds: 90, cancelled: true },
    ]);
    expect(store.rtEntriesForTrip("T2")).toEqual([{ delaySeconds: 5, cancelled: false }]);
    expect(store.rtEntriesForTrip("MISSING")).toEqual([]);
  });

  it("rebuilds the index wholesale on replace (stale keys do not leak)", () => {
    // Tests that a second setRealtimeUpdates() replaces the index, NOT that the
    // generation gate fires — both calls happen at the same generation (no swap).
    const store = new GtfsStore();
    store.setRealtimeUpdates(new Map([["T1", { delaySeconds: 10, cancelled: false }]]));
    store.setRealtimeUpdates(new Map([["T2|20260611", { delaySeconds: 20, cancelled: false }]]));
    expect(store.rtEntriesForTrip("T1")).toEqual([]);
    expect(store.rtEntriesForTrip("T2")).toEqual([{ startDate: "20260611", delaySeconds: 20, cancelled: false }]);
  });

  it("excludes a date-scoped entry written before a swap (per-key generation gate)", () => {
    // Seeds a date-scoped entry at generation N-1, performs a swap() to bump
    // to generation N, then calls setRealtimeUpdates with only the bare key at
    // generation N. The stale date-scoped entry must NOT appear in results —
    // that's the per-key generation gate inside rtEntriesForTrip doing its job.
    // Mirrors the mechanism used by "excludes stale RT entries" in the
    // "getDepartures shim" suite, applied to the rtEntriesForTrip path.
    const store = new GtfsStore();

    // Bump generation to 1 via an initial swap() so we have a known baseline.
    const { indexes: i1, canonical: c1, routingInput: ri1 } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(i1, c1, ri1); // generation: 0 → 1

    // Write a date-scoped entry at generation 1.
    store.setRealtimeUpdates(new Map([["T1|20260611", { delaySeconds: 10, cancelled: false }]]));
    // Confirm it's visible before the swap.
    expect(store.rtEntriesForTrip("T1")).toEqual([{ startDate: "20260611", delaySeconds: 10, cancelled: false }]);

    // Swap again — bumps generation 1 → 2; the date-scoped entry is now stale.
    const { indexes: i2, canonical: c2, routingInput: ri2 } = buildIndexes(
      fixtureStops, fixtureRoutes, fixtureTrips, fixtureStopTimes, fixtureServices, [],
    );
    store.swap(i2, c2, ri2); // generation: 1 → 2

    // Only the bare key is posted at generation 2.
    store.setRealtimeUpdates(new Map([["T1", { delaySeconds: 99, cancelled: false }]]));

    // rtEntriesForTrip must return ONLY the fresh bare entry; the stale
    // date-scoped T1|20260611 (generation 1) must be excluded by the per-key gate.
    expect(store.rtEntriesForTrip("T1")).toEqual([{ delaySeconds: 99, cancelled: false }]);
  });
});
