import { seedLegacyCityProjection } from "../../src/test-helpers/cityData.ts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  computeWalkingProgress,
  computeWalkRouteProgress,
  computeTransitProgress,
  computeRideProgress,
  shouldAdvanceLeg,
  useGuidanceLegProgress,
} from "../../src/hooks/useGuidanceLegProgress.ts";
import { db } from "../../src/db/index.ts";
import { useGuidanceStore } from "../../src/stores/guidanceStore.ts";
import { useRtStore } from "../../src/stores/rtStore.ts";
import type { Itinerary, Leg } from "@pt/shared";
import { walkGraphClient, type WalkRoute } from "../../src/services/walkGraphClient.ts";
import { clearWalkRouteCache, getOrFetchWalkRoute } from "../../src/services/walkRouteCache.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";

const walkLeg: Leg = {
  mode: "WALK",
  from: { name: "Origin", location: { lat: 54.350, lon: 18.640 } },
  to: { name: "Stop A", location: { lat: 54.355, lon: 18.650 } },
  departureTime: "2026-03-28T10:00:00Z",
  arrivalTime: "2026-03-28T10:05:00Z",
  durationSeconds: 300,
  distanceMeters: 600,
};

const transitLeg: Leg = {
  mode: "TRAM",
  from: { name: "Stop A", stopId: "s1", location: { lat: 54.355, lon: 18.650 } },
  to: { name: "Stop B", stopId: "s2", location: { lat: 54.370, lon: 18.670 } },
  departureTime: "2026-03-28T10:08:00Z",
  arrivalTime: "2026-03-28T10:20:00Z",
  durationSeconds: 720,
  routeShortName: "2",
  tripId: "trip_1",
  intermediateStops: 4,
  polyline: "_p~iF~ps|U_ulLnnqC",
};


// East 0.001° lon (~64.7 m at 54.35°N), then north 0.001° lat (~111.2 m).
const walkRoute: WalkRoute = {
  coords: [[18.640, 54.350], [18.641, 54.350], [18.641, 54.351]],
  distanceMeters: 176,
  steps: [
    { kind: "depart", name: "Długa", distanceMeters: 64.7, startIndex: 0 },
    { kind: "turn", turn: "left", name: "Ogarna", distanceMeters: 111.2, startIndex: 1 },
    { kind: "arrive", name: "", distanceMeters: 0, startIndex: 2 },
  ],
};

describe("computeWalkingProgress", () => {
  it("computes distance remaining from position near start", () => {
    const pos = { lat: 54.350, lon: 18.640 };
    const result = computeWalkingProgress(walkLeg, pos);
    expect(result.distanceRemainingMeters).toBeGreaterThan(400);
    expect(result.bearingDegrees).not.toBeNull();
  });

  it("computes low distance remaining near destination", () => {
    const pos = { lat: 54.354, lon: 18.649 };
    const result = computeWalkingProgress(walkLeg, pos);
    expect(result.distanceRemainingMeters).toBeLessThan(200);
  });

  it("reports the share of the walk still ahead", () => {
    expect(computeWalkingProgress(walkLeg, { lat: 54.350, lon: 18.640 }).remainingFraction).toBeCloseTo(1, 2);
    expect(computeWalkingProgress(walkLeg, { lat: 54.3525, lon: 18.645 }).remainingFraction).toBeCloseTo(0.5, 1);
  });

  it("returns positive estimated time remaining", () => {
    const pos = { lat: 54.352, lon: 18.645 };
    const result = computeWalkingProgress(walkLeg, pos);
    expect(result.estimatedSecondsRemaining).toBeGreaterThan(0);
  });

  it("follows the walk-graph path and reports the next step", () => {
    const atStart = computeWalkingProgress(walkLeg, { lat: 54.350, lon: 18.640 }, walkRoute);
    expect(atStart.distanceRemainingMeters).toBeGreaterThan(170);
    expect(atStart.distanceRemainingMeters).toBeLessThan(180);
    expect(atStart.nextStep).toMatchObject({ kind: "turn", turn: "left", name: "Ogarna" });
    expect(atStart.nextStep!.distanceToStartMeters).toBeGreaterThan(60);
    expect(atStart.nextStep!.distanceToStartMeters).toBeLessThan(70);
    expect(atStart.bearingDegrees).toBeCloseTo(90, 0);

    const pastTurn = computeWalkingProgress(walkLeg, { lat: 54.3505, lon: 18.641 }, walkRoute);
    expect(pastTurn.nextStep?.kind).toBe("arrive");
    expect(pastTurn.distanceRemainingMeters).toBeLessThan(60);
  });

  it("carries the turn onto a crossing into the next step", () => {
    const crossing: WalkRoute = {
      ...walkRoute,
      steps: [
        walkRoute.steps[0]!,
        { kind: "cross", turn: "left", name: "", distanceMeters: 111.2, startIndex: 1 },
        walkRoute.steps[2]!,
      ],
    };
    expect(computeWalkingProgress(walkLeg, { lat: 54.350, lon: 18.640 }, crossing).nextStep)
      .toMatchObject({ kind: "cross", turn: "left" });
  });

  it("keeps the chord behaviour without a route", () => {
    expect(computeWalkingProgress(walkLeg, { lat: 54.350, lon: 18.640 }, null).nextStep).toBeUndefined();
  });
});

describe("computeTransitProgress", () => {
  it("computes stops remaining based on progress", () => {
    const result = computeTransitProgress(transitLeg, 0.5, 60);
    expect(result.stopsRemaining).toBeGreaterThanOrEqual(1);
    expect(result.stopsRemaining).toBeLessThanOrEqual(4);
    expect(result.delaySeconds).toBe(60);
  });

  it("returns null currentStopName with no intermediate stop data", () => {
    const result = computeTransitProgress(transitLeg, 0.2, 0);
    // Without stop list, currentStopName is derived from progress
    expect(result.stopsRemaining).toBeGreaterThan(0);
  });
});

describe("shouldAdvanceLeg", () => {
  it("returns true when near walk leg destination", () => {
    const pos = { lat: 54.3549, lon: 18.6499 };
    expect(shouldAdvanceLeg(walkLeg, pos)).toBe(true);
  });

  it("returns false when far from walk leg destination", () => {
    const pos = { lat: 54.350, lon: 18.640 };
    expect(shouldAdvanceLeg(walkLeg, pos)).toBe(false);
  });

  it("returns true when near transit leg destination", () => {
    const pos = { lat: 54.3699, lon: 18.6699 };
    expect(shouldAdvanceLeg(transitLeg, pos)).toBe(true);
  });
});

/** Guidance on `itinerary`, without startNavigation's RT subscription (which polls the network). */
function navigate(itinerary: Itinerary) {
  useGuidanceStore.setState({
    phase: "navigating",
    itinerary,
    currentLegIndex: 0,
    legStatuses: itinerary.legs.map((_, i) => (i === 0 ? "current" : "future")),
    walkingProgress: null,
    transitProgress: null,
  });
}

describe("useGuidanceLegProgress — a ride that has not left yet", () => {
  // On-device itineraries carry no polyline, so progress is read along the
  // straight from → to chord. A position three quarters of the way along a
  // 5-stop ride reads as "1 stop remaining" — the get-off alarm's trigger.
  const ride: Leg = {
    mode: "BUS",
    from: { name: "Stop A", stopId: "s1", location: { lat: 54.355, lon: 18.650 } },
    to: { name: "Stop B", stopId: "s2", location: { lat: 54.370, lon: 18.670 } },
    departureTime: "2026-09-25T20:03:00Z",
    arrivalTime: "2026-09-25T20:27:00Z",
    durationSeconds: 1440,
    routeShortName: "3",
    tripId: "trip_3",
    intermediateStops: 4,
  };
  const itinerary: Itinerary = {
    legs: [ride],
    departureTime: ride.departureTime,
    arrivalTime: ride.arrivalTime,
    durationSeconds: 1440,
    transfers: 0,
    walkingDistanceMeters: 0,
  };
  const farAlong = { lat: 54.36625, lon: 18.665 };
  const realGetTripDelay = useRtStore.getState().getTripDelay;

  beforeEach(() => {
    vi.useFakeTimers();
    useGuidanceStore.getState().reset();
    navigate(itinerary);
  });

  afterEach(() => {
    useGuidanceStore.getState().reset();
    useRtStore.setState({ getTripDelay: realGetTripDelay });
    vi.useRealTimers();
  });

  it("does not put the rider aboard before the vehicle leaves", () => {
    vi.setSystemTime(new Date("2026-09-25T18:39:00Z")); // 84 min before departure
    renderHook(() => useGuidanceLegProgress(farAlong, null));
    expect(useGuidanceStore.getState().transitProgress).toBeNull();
  });

  it("tracks the ride once the vehicle has left", () => {
    vi.setSystemTime(new Date("2026-09-25T20:15:00Z"));
    renderHook(() => useGuidanceLegProgress(farAlong, null));
    expect(useGuidanceStore.getState().transitProgress?.stopsRemaining).toBe(1);
  });

  it("counts a live delay: still waiting while the late bus has not come", () => {
    // Scheduled 20:03, running 10 min late → it is not moving at 20:08.
    useRtStore.setState({
      getTripDelay: (tripId: string) =>
        tripId === "trip_3" ? { delaySeconds: 600, cancelled: false } : null,
    } as never);
    vi.setSystemTime(new Date("2026-09-25T20:08:00Z"));
    renderHook(() => useGuidanceLegProgress(farAlong, null));
    expect(useGuidanceStore.getState().transitProgress).toBeNull();
  });
});

describe("computeRideProgress — along the leg's own stops", () => {
  // Four stops due east, ~640 m apart (0.01° of longitude at 54.68° N).
  const stops = [
    { id: "a", name: "Alpha", lat: 54.68, lon: 25.25 },
    { id: "b", name: "Bravo", lat: 54.68, lon: 25.26 },
    { id: "c", name: "Charlie", lat: 54.68, lon: 25.27 },
    { id: "d", name: "Delta", lat: 54.68, lon: 25.28 },
  ];

  it("counts every stop ahead from the boarding stop", () => {
    const p = computeRideProgress(stops, { lat: 54.68, lon: 25.25 }, 0);
    expect(p).toEqual({ currentStopName: "Alpha", stopsRemaining: 3, delaySeconds: 0 });
  });

  it("names the nearest stop and counts from the stop being approached", () => {
    const p = computeRideProgress(stops, { lat: 54.6801, lon: 25.268 }, 120);
    expect(p).toEqual({ currentStopName: "Charlie", stopsRemaining: 2, delaySeconds: 120 });
  });

  it("says the rider's stop is next on the last stretch", () => {
    expect(computeRideProgress(stops, { lat: 54.68, lon: 25.275 }, 0)?.stopsRemaining).toBe(1);
  });

  it("puts nobody aboard who is nowhere near the route", () => {
    // ~1.1 km north of the line: at home, or on another street entirely.
    expect(computeRideProgress(stops, { lat: 54.69, lon: 25.265 }, 0)).toBeNull();
  });
});

describe("useGuidanceLegProgress — ride progress from the leg's stops", () => {
  const stopRows = [
    { id: "s1", name: "Alpha", lat: 54.68, lon: 25.25 },
    { id: "s2", name: "Bravo", lat: 54.68, lon: 25.26 },
    { id: "s3", name: "Charlie", lat: 54.68, lon: 25.27 },
  ];
  const ride: Leg = {
    mode: "BUS",
    from: { name: "Alpha", stopId: "s1", location: { lat: 54.68, lon: 25.25 } },
    to: { name: "Charlie", stopId: "s3", location: { lat: 54.68, lon: 25.27 } },
    departureTime: "2026-09-25T20:03:00Z",
    arrivalTime: "2026-09-25T20:10:00Z",
    durationSeconds: 420,
    routeShortName: "3",
    tripId: "trip_s",
    routeId: "r3",
    intermediateStops: 1,
    boardStopIdx: 0,
    alightStopIdx: 2,
    patternStopIds: ["s1", "s2", "s3"],
  };
  const itinerary: Itinerary = {
    legs: [ride],
    departureTime: ride.departureTime,
    arrivalTime: ride.arrivalTime,
    durationSeconds: 420,
    transfers: 0,
    walkingDistanceMeters: 0,
  };

  beforeEach(async () => {
    await db.gtfsStops.clear();
    await seedLegacyCityProjection();
    await db.gtfsStops.bulkPut(stopRows);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-25T20:05:00Z")); // the bus has left
    useGuidanceStore.getState().reset();
    navigate(itinerary);
  });

  afterEach(() => {
    useGuidanceStore.getState().reset();
    vi.useRealTimers();
  });

  it("names the stop the rider is at, from the leg's stop list", async () => {
    renderHook(() => useGuidanceLegProgress({ lat: 54.68, lon: 25.2601 }, null));
    await waitFor(() =>
      expect(useGuidanceStore.getState().transitProgress).toEqual({
        currentStopName: "Bravo",
        stopsRemaining: 1,
        delaySeconds: 0,
      }),
    );
  });

  it("does not put a rider who is off the route aboard", async () => {
    const { rerender } = renderHook(({ pos }) => useGuidanceLegProgress(pos, null), {
      initialProps: { pos: { lat: 54.69, lon: 25.2601 } },
    });
    // Let the stop list load, then move once more so the hook re-runs with it.
    await waitFor(async () => expect(await db.gtfsStops.count()).toBe(3));
    await new Promise((r) => setTimeout(r, 20));
    rerender({ pos: { lat: 54.6901, lon: 25.2601 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(useGuidanceStore.getState().transitProgress).toBeNull();
  });
});

describe("useGuidanceLegProgress — walk-graph steps", () => {
  beforeEach(() => {
    clearWalkRouteCache();
    useSettingsStore.setState({ mobilityProfile: "default" });
  });

  it("reads the cached walk route for the current leg", async () => {
    const cityId = useCityStore.getState().activeCity.id;
    await getOrFetchWalkRoute(cityId, walkLeg.from.location, walkLeg.to.location, "default", {
      routeFor: async () => walkRoute,
    });
    navigate({ legs: [walkLeg], departureTime: walkLeg.departureTime, arrivalTime: walkLeg.arrivalTime } as Itinerary);
    renderHook(() => useGuidanceLegProgress({ lat: 54.350, lon: 18.640 }, null));
    await waitFor(() =>
      expect(useGuidanceStore.getState().walkingProgress?.nextStep).toMatchObject({ kind: "turn", name: "Ogarna" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has no next step when the leg has no walk route", async () => {
    vi.spyOn(walkGraphClient, "routeFor").mockResolvedValue(null);
    navigate({ legs: [walkLeg], departureTime: walkLeg.departureTime, arrivalTime: walkLeg.arrivalTime } as Itinerary);
    renderHook(() => useGuidanceLegProgress({ lat: 54.350, lon: 18.640 }, null));
    await waitFor(() => expect(useGuidanceStore.getState().walkingProgress).not.toBeNull());
    expect(useGuidanceStore.getState().walkingProgress?.nextStep).toBeUndefined();
  });

  it("picks up a route that resolves after guidance starts, with no new fix", async () => {
    let resolve!: (r: WalkRoute) => void;
    const routeFor = vi.spyOn(walkGraphClient, "routeFor").mockReturnValue(
      new Promise<WalkRoute>((r) => { resolve = r; }),
    );
    navigate({ legs: [walkLeg], departureTime: walkLeg.departureTime, arrivalTime: walkLeg.arrivalTime } as Itinerary);
    const here = { lat: 54.350, lon: 18.640 };
    renderHook(() => useGuidanceLegProgress(here, null));
    await waitFor(() => expect(useGuidanceStore.getState().walkingProgress).not.toBeNull());
    expect(useGuidanceStore.getState().walkingProgress?.nextStep).toBeUndefined();
    resolve(walkRoute);
    await waitFor(() =>
      expect(useGuidanceStore.getState().walkingProgress?.nextStep).toMatchObject({ kind: "turn", name: "Ogarna" }),
    );
    expect(routeFor).toHaveBeenCalledTimes(1);
  });

  it("asks for no route on a transit leg", async () => {
    const routeFor = vi.spyOn(walkGraphClient, "routeFor").mockResolvedValue(null);
    navigate({ legs: [transitLeg], departureTime: transitLeg.departureTime, arrivalTime: transitLeg.arrivalTime } as Itinerary);
    renderHook(() => useGuidanceLegProgress({ lat: 54.360, lon: 18.660 }, null));
    await new Promise((r) => setTimeout(r, 0));
    expect(routeFor).not.toHaveBeenCalled();
  });
});

// Metres → degrees at 54.35°N.
const M_LAT = 1 / 111_195;
const M_LON = M_LAT / Math.cos((54.35 * Math.PI) / 180);
const at = (eastM: number, northM: number) => ({ lat: 54.35 + northM * M_LAT, lon: 18.64 + eastM * M_LON });
const lonLat = (eastM: number, northM: number): [number, number] => {
  const p = at(eastM, northM);
  return [p.lon, p.lat];
};

describe("computeWalkRouteProgress — forward along a path that doubles back", () => {
  // East 100 m along one sidewalk, 15 m north across the street, then back
  // west 100 m along the other sidewalk: two legs 15 m apart.
  const uPath: WalkRoute = {
    coords: [lonLat(0, 0), lonLat(100, 0), lonLat(100, 15), lonLat(0, 15)],
    distanceMeters: 215,
    steps: [
      { kind: "depart", name: "A", distanceMeters: 100, startIndex: 0 },
      { kind: "cross", turn: "left", name: "", distanceMeters: 15, startIndex: 1 },
      { kind: "turn", turn: "left", name: "B", distanceMeters: 100, startIndex: 2 },
      { kind: "arrive", name: "", distanceMeters: 0, startIndex: 3 },
    ],
  };

  it("stays on the first side when noise lands nearer the far side", () => {
    // 9 m north of the first side, 6 m from the far one.
    const noisy = at(30, 9);
    // The globally nearest segment is the far side: Cross and the turn are skipped.
    expect(computeWalkingProgress(walkLeg, noisy, uPath).nextStep?.kind).toBe("arrive");
    const { alongMeters: first } = computeWalkRouteProgress(walkLeg, at(25, 0), uPath);
    expect(first).toBeCloseTo(25, 0);
    const { progress, alongMeters } = computeWalkRouteProgress(walkLeg, noisy, uPath, first);
    expect(alongMeters).toBeCloseTo(30, 0);
    expect(progress.nextStep).toMatchObject({ kind: "cross", turn: "left" });
    expect(progress.nextStep!.distanceToStartMeters).toBeCloseTo(70, -1);
  });

  it("follows the rider round the bend onto the far side", () => {
    let along = computeWalkRouteProgress(walkLeg, at(90, 0), uPath).alongMeters;
    along = computeWalkRouteProgress(walkLeg, at(100, 8), uPath, along).alongMeters;
    const { progress } = computeWalkRouteProgress(walkLeg, at(85, 15), uPath, along);
    expect(progress.nextStep?.kind).toBe("arrive");
  });

  it("re-acquires after a big jump away from the window", () => {
    const line: WalkRoute = {
      coords: [lonLat(0, 0), lonLat(300, 0)],
      distanceMeters: 300,
      steps: [
        { kind: "depart", name: "A", distanceMeters: 300, startIndex: 0 },
        { kind: "arrive", name: "", distanceMeters: 0, startIndex: 1 },
      ],
    };
    const { alongMeters } = computeWalkRouteProgress(walkLeg, at(250, 2), line, 10);
    expect(alongMeters).toBeCloseTo(250, 0);
  });
});
