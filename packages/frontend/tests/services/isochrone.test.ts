import { describe, it, expect, vi } from "vitest";
import { findReachableStops } from "../../src/services/isochrone.ts";
import type { LatLon } from "@pt/shared";
import {
  DEFAULT_WALK_SPEED_MPS,
  MAX_RUN_SPEED_MPS,
  OSRM_FOOT_SPEED_MPS,
  RUN_TO_CATCH_SPEED_FACTOR,
  WHEELCHAIR_WALK_SPEED_MPS,
} from "@pt/shared";

const stops = [
  { id: "S1", name: "Stop A", lat: 54.6872, lon: 25.2797 },
  { id: "S2", name: "Stop B", lat: 54.6882, lon: 25.2797 },
  { id: "S3", name: "Stop C", lat: 54.6972, lon: 25.2797 },
  { id: "S4", name: "Stop D", lat: 54.7072, lon: 25.2797 },
];

const origin: LatLon = { lat: 54.6872, lon: 25.2797 };

describe("findReachableStops", () => {
  it("uses OSRM table when available", async () => {
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 90, 800, 1800]], // durations from origin to each stop
      }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 1200 },
      mockOsrm as any,
      "default",
    );

    expect(mockOsrm.table).toHaveBeenCalledTimes(1);
    // S1 (0s), S2 (90s), S3 (800s) are within 900s; S4 (1800s) is not
    const ids = result.map((r) => r.stopId);
    expect(ids).toContain("S1");
    expect(ids).toContain("S2");
    expect(ids).toContain("S3");
    expect(ids).not.toContain("S4");
  });

  it("falls back to radius-based when OSRM not ready", async () => {
    const mockOsrm = { isReady: () => false, table: vi.fn() };

    const result = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 800 },
      mockOsrm as any,
    );

    expect(mockOsrm.table).not.toHaveBeenCalled();
    // Should fall back to radius-based: S1 and S2 within 800m
    const ids = result.map((r) => r.stopId);
    expect(ids).toContain("S1");
    expect(ids).toContain("S2");
    expect(ids).not.toContain("S3"); // 1111m > 800m
  });

  it("falls back when OSRM table returns null", async () => {
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue(null),
    };

    const result = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 800 },
      mockOsrm as any,
    );

    const ids = result.map((r) => r.stopId);
    expect(ids).toContain("S1");
    expect(ids).toContain("S2");
  });

  it("returns sorted by walk time ascending", async () => {
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[500, 90, 200, 50]],
      }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 1200 },
      mockOsrm as any,
    );

    for (let i = 1; i < result.length; i++) {
      expect(result[i].walkSecs).toBeGreaterThanOrEqual(result[i - 1].walkSecs);
    }
  });

  it("adds a stop that is out of walking reach but inside the SAME budget at a run", async () => {
    // Raw OSRM 850 s at its 1.389 m/s foot profile ≈ 1181 m. At the user's
    // 1.25 m/s that is ~945 s of walking — over the 900 s budget — but ~472 s
    // at the 2.5 m/s run speed, so the stop is reachable without widening the
    // budget by a single second.
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 90, 850, 2000]],
      }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      {
        maxWalkSecs: 900,
        walkSpeedMps: DEFAULT_WALK_SPEED_MPS,
        radiusMeters: 1200,
        runToCatch: true,
      },
      mockOsrm as any,
    );

    const ids = result.map((r) => r.stopId);
    expect(ids).toContain("S1"); // within walk
    expect(ids).toContain("S2"); // within walk
    expect(ids).toContain("S3"); // run-to-catch
    // Raw 2000 s ≈ 2778 m: 1111 s even at a run, still past the budget. The
    // budget is a cap on time, and running does not raise the cap.
    expect(ids).not.toContain("S4");

    const s3 = result.find((r) => r.stopId === "S3");
    expect(s3?.runToCatch).toBe(true);

    // Normal stops should not have runToCatch flag
    const s1 = result.find((r) => r.stopId === "S1");
    expect(s1?.runToCatch).toBeUndefined();
  });

  it("carries the RUNNING time for a run-to-catch stop, not the walking time", async () => {
    // The regression this pins: run-to-catch used to hand out 120 s of extra
    // budget and return the stop at its full walking time, so the planner told
    // the rider to leave for a departure they could only make by running —
    // and then never shortened the leg. Speed is the whole mechanism.
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 90, 850, 2000]],
      }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      {
        maxWalkSecs: 900,
        walkSpeedMps: DEFAULT_WALK_SPEED_MPS,
        radiusMeters: 1200,
        runToCatch: true,
      },
      mockOsrm as any,
    );

    const s3 = result.find((r) => r.stopId === "S3")!;
    const distanceMeters = Math.round(850 * OSRM_FOOT_SPEED_MPS);
    const runSpeed = Math.min(
      DEFAULT_WALK_SPEED_MPS * RUN_TO_CATCH_SPEED_FACTOR,
      MAX_RUN_SPEED_MPS,
    );
    expect(s3.distanceMeters).toBe(distanceMeters);
    expect(s3.walkSecs).toBe(Math.round(distanceMeters / runSpeed));
    // Strictly faster than walking it, and inside the untouched budget.
    expect(s3.walkSecs).toBeLessThan(
      Math.round(distanceMeters / DEFAULT_WALK_SPEED_MPS),
    );
    expect(s3.walkSecs).toBeLessThanOrEqual(900);
  });

  it("applies the same speed model on the haversine fallback path", async () => {
    const mockOsrm = { isReady: () => false, table: vi.fn() };

    const result = await findReachableStops(
      origin,
      stops,
      {
        maxWalkSecs: 900,
        walkSpeedMps: DEFAULT_WALK_SPEED_MPS,
        radiusMeters: 800,
        runToCatch: true,
      },
      mockOsrm as any,
    );

    // S3 sits ~1111 m out: past the 800 m walking radius, inside the 1600 m a
    // runner covers in the same time, and it arrives with a running time.
    const s3 = result.find((r) => r.stopId === "S3");
    expect(s3?.runToCatch).toBe(true);
    const runSpeed = Math.min(
      DEFAULT_WALK_SPEED_MPS * RUN_TO_CATCH_SPEED_FACTOR,
      MAX_RUN_SPEED_MPS,
    );
    expect(s3!.walkSecs).toBe(Math.round(s3!.distanceMeters / runSpeed));
    // S4 (~2222 m) is beyond even that.
    expect(result.map((r) => r.stopId)).not.toContain("S4");
  });

  it("excludes run-to-catch stops when runToCatch is false (default profile)", async () => {
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 90, 950, 1800]],
      }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 1200, runToCatch: false },
      mockOsrm as any,
      "default",
    );

    const ids = result.map((r) => r.stopId);
    expect(ids).toContain("S1");
    expect(ids).toContain("S2");
    expect(ids).not.toContain("S3"); // 950s > 900s, no run-to-catch
    expect(ids).not.toContain("S4");
  });

  it("disables run-to-catch for wheelchair profile even when runToCatch is true", async () => {
    // OSRM 950 s: for the default profile that is ~1319 m, i.e. ~1055 s of
    // walking (over budget) but ~528 s at a run, so S3 would be a run-to-catch
    // stop. Wheelchair walks at 0.8 m/s and cannot run at all, so run-to-catch
    // is force-disabled regardless of the toggle.
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 90, 950, 1800]],
      }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 1200, runToCatch: true },
      mockOsrm as any,
      "wheelchair",
    );

    const withRunFlag = result.filter((r) => r.runToCatch);
    expect(withRunFlag).toHaveLength(0);
  });

  it("scales OSRM walkSecs by effective speed for wheelchair profile", async () => {
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 80, 400]],
      }),
    };
    const threeStops = [
      { id: "A", name: "A", lat: 54.6872, lon: 25.2797 },
      { id: "B", name: "B", lat: 54.6882, lon: 25.2797 },
      { id: "C", name: "C", lat: 54.6972, lon: 25.2797 },
    ];

    const result = await findReachableStops(
      origin,
      threeStops,
      { maxWalkSecs: 900, walkSpeedMps: DEFAULT_WALK_SPEED_MPS, radiusMeters: 2000 },
      mockOsrm as any,
      "wheelchair",
    );

    const b = result.find((r) => r.stopId === "B");
    // 80s at OSRM's 5 km/h foot profile ≈ 111m; 111m / 0.8 m/s ≈ 139s walkSecs.
    expect(b?.walkSecs).toBe(
      Math.round((80 * OSRM_FOOT_SPEED_MPS) / WHEELCHAIR_WALK_SPEED_MPS),
    );
    expect(b?.distanceMeters).toBe(Math.round(80 * OSRM_FOOT_SPEED_MPS));
  });

  it("rescales OSRM walkSecs to the user's default speed (OSRM 5 km/h → user 4.5 km/h)", async () => {
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 80, 400]],
      }),
    };
    const threeStops = [
      { id: "A", name: "A", lat: 54.6872, lon: 25.2797 },
      { id: "B", name: "B", lat: 54.6882, lon: 25.2797 },
      { id: "C", name: "C", lat: 54.6972, lon: 25.2797 },
    ];

    const result = await findReachableStops(
      origin,
      threeStops,
      { maxWalkSecs: 900, walkSpeedMps: DEFAULT_WALK_SPEED_MPS, radiusMeters: 2000 },
      mockOsrm as any,
      "default",
    );

    const b = result.find((r) => r.stopId === "B");
    // 80s * 1.389 / 1.25 ≈ 89s.
    expect(b?.walkSecs).toBe(
      Math.round((80 * OSRM_FOOT_SPEED_MPS) / DEFAULT_WALK_SPEED_MPS),
    );
  });

  it("excludes OSRM stops where wheelchair-adjusted walkSecs exceeds maxWalkSecs", async () => {
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: [[0, 500]],
      }),
    };
    const twoStops = [
      { id: "A", name: "A", lat: 54.6872, lon: 25.2797 },
      { id: "Far", name: "Far", lat: 54.6882, lon: 25.2797 },
    ];
    const options = {
      maxWalkSecs: 600,
      walkSpeedMps: DEFAULT_WALK_SPEED_MPS,
      radiusMeters: 2000,
    };

    const defaultResult = await findReachableStops(
      origin, twoStops, options, mockOsrm as any, "default",
    );
    const wheelchairResult = await findReachableStops(
      origin, twoStops, options, mockOsrm as any, "wheelchair",
    );

    // Default: 500s * 1.389/1.25 ≈ 556s < 600s → included
    expect(defaultResult.map((r) => r.stopId)).toContain("Far");
    // Wheelchair: 500s * 1.389/0.8 ≈ 868s > 600s → excluded
    expect(wheelchairResult.map((r) => r.stopId)).not.toContain("Far");
  });

  it("scales radius-fallback walkSecs by wheelchair speed", async () => {
    const mockOsrm = { isReady: () => false, table: vi.fn() };

    const defaultResult = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: DEFAULT_WALK_SPEED_MPS, radiusMeters: 800 },
      mockOsrm as any,
      "default",
    );
    const wheelchairResult = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: DEFAULT_WALK_SPEED_MPS, radiusMeters: 800 },
      mockOsrm as any,
      "wheelchair",
    );

    const s2Default = defaultResult.find((r) => r.stopId === "S2");
    const s2Wheelchair = wheelchairResult.find((r) => r.stopId === "S2");
    expect(s2Default).toBeDefined();
    expect(s2Wheelchair).toBeDefined();
    // Same distance, slower speed → strictly larger walkSecs
    expect(s2Wheelchair!.walkSecs).toBeGreaterThan(s2Default!.walkSecs);
    // Physical distance unchanged
    expect(s2Wheelchair!.distanceMeters).toBe(s2Default!.distanceMeters);
  });

  it("flips the OSRM table query direction when role='destination'", async () => {
    // role="origin" should query sources=[origin], destinations=stops;
    // role="destination" should query sources=stops, destinations=[origin]
    // so an asymmetric foot profile yields the correct exit-walk durations.
    const mockOsrm = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({ durations: [[0, 90, 200, 400]] }),
    };

    await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 1200, role: "origin" },
      mockOsrm as any,
    );
    expect(mockOsrm.table).toHaveBeenLastCalledWith(
      [origin],
      stops.map((s) => ({ lat: s.lat, lon: s.lon })),
    );

    // For role="destination", each row is one stop (source) and a single
    // column (destination = origin). The mock returns durations[i][0].
    const exitMock = {
      isReady: () => true,
      table: vi.fn().mockResolvedValue({
        durations: stops.map((_, i) => [i * 100]),
      }),
    };
    const exit = await findReachableStops(
      origin,
      stops,
      { maxWalkSecs: 900, walkSpeedMps: 1.25, radiusMeters: 1200, role: "destination" },
      exitMock as any,
    );
    expect(exitMock.table).toHaveBeenLastCalledWith(
      stops.map((s) => ({ lat: s.lat, lon: s.lon })),
      [origin],
    );
    // S1 (0s) is the nearest; verify the per-row reduction picked the
    // right column rather than reading a stale durations[0] vector.
    expect(exit[0].stopId).toBe("S1");
  });

  // --- Forced stop-group member ids (force-to-walkSecs:0) ---
  // Geometry: origin == S1 (0m), S2 ≈ 111m, S3 ≈ 1111m, S4 ≈ 2222m.

  it("radius path: forces an out-of-radius origin member id in at walkSecs:0", async () => {
    const mockOsrm = { isReady: () => false, table: vi.fn() };

    const result = await findReachableStops(
      origin,
      stops,
      {
        maxWalkSecs: 900,
        walkSpeedMps: 1.25,
        radiusMeters: 800, // S4 (~2222m) is far outside this radius
        originStopIds: ["S4"],
        role: "origin",
      },
      mockOsrm as any,
    );

    expect(mockOsrm.table).not.toHaveBeenCalled();
    const s4 = result.filter((r) => r.stopId === "S4");
    expect(s4).toHaveLength(1); // forced in, no dup
    expect(s4[0].walkSecs).toBe(0);
    expect(s4[0].distanceMeters).toBe(0);
    // Forced walkSecs:0 sorts to the front (S1==origin is also 0s; stable
    // sort keeps both at the head, S4 among them).
    expect(result[0].walkSecs).toBe(0);
  });

  it("OSRM path: overrides an in-radius origin member's walkSecs to 0 with no dup", async () => {
    const mockOsrm = {
      isReady: () => true,
      // S1 gets a non-zero raw duration so we can observe the override.
      table: vi.fn().mockResolvedValue({ durations: [[120, 90, 200, 1800]] }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      {
        maxWalkSecs: 900,
        walkSpeedMps: 1.25,
        radiusMeters: 1200,
        originStopIds: ["S1"],
        role: "origin",
      },
      mockOsrm as any,
    );

    expect(mockOsrm.table).toHaveBeenCalledTimes(1);
    const s1 = result.filter((r) => r.stopId === "S1");
    expect(s1).toHaveLength(1); // overridden in place, not duplicated
    expect(s1[0].walkSecs).toBe(0);
    expect(s1[0].distanceMeters).toBe(0);
    expect(result[0].stopId).toBe("S1"); // sorts first
  });

  it("destination side: forces an out-of-radius dest member id in at walkSecs:0 (symmetry)", async () => {
    const mockOsrm = { isReady: () => false, table: vi.fn() };

    const result = await findReachableStops(
      origin,
      stops,
      {
        maxWalkSecs: 900,
        walkSpeedMps: 1.25,
        radiusMeters: 800, // S4 (~2222m) outside radius
        destStopIds: ["S4"],
        role: "destination",
      },
      mockOsrm as any,
    );

    const s4 = result.filter((r) => r.stopId === "S4");
    expect(s4).toHaveLength(1);
    expect(s4[0].walkSecs).toBe(0);
    expect(s4[0].distanceMeters).toBe(0);
  });

  it("OSRM path: forces an out-of-radius dest member id in at walkSecs:0 (role-gated)", async () => {
    const mockOsrm = {
      isReady: () => true,
      // role=destination → per-row reduction over [stop -> origin].
      // S4's raw duration is huge so it'd be excluded without the force-in.
      table: vi.fn().mockResolvedValue({
        durations: stops.map((s) => (s.id === "S4" ? [5000] : [100])),
      }),
    };

    const result = await findReachableStops(
      origin,
      stops,
      {
        maxWalkSecs: 900,
        walkSpeedMps: 1.25,
        radiusMeters: 1200,
        // originStopIds must be ignored on the destination side.
        originStopIds: ["S2"],
        destStopIds: ["S4"],
        role: "destination",
      },
      mockOsrm as any,
    );

    const s4 = result.filter((r) => r.stopId === "S4");
    expect(s4).toHaveLength(1);
    expect(s4[0].walkSecs).toBe(0);
    // S2 should keep its computed (non-zero) walkSecs — origin ids don't
    // apply to the destination side.
    const s2 = result.find((r) => r.stopId === "S2");
    expect(s2?.walkSecs).toBeGreaterThan(0);
  });
});
