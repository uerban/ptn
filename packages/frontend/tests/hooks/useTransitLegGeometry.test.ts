import { seedLegacyCityProjection } from "../../src/test-helpers/cityData.ts";
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { db } from "../../src/db/index.ts";
import { useTransitLegGeometry } from "../../src/hooks/useTransitLegGeometry.ts";
import { clearShapeDecodeCache } from "../../src/services/legGeometry/shapeDecodeCache.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import * as errorReporter from "../../src/services/errorReporter.ts";
import type { RaptorLeg } from "@pt/shared";
import { waitForLiveQuery } from "./waitForLiveQuery.ts";

const LEG: RaptorLeg = {
  type: "transit",
  fromStopId: "A",
  toStopId: "C",
  departSecs: 0,
  arriveSecs: 300,
  routeId: "R1",
  tripId: "T1",
  boardStopIdx: 0,
  alightStopIdx: 2,
};

beforeEach(async () => {
  clearShapeDecodeCache();
  await db.delete();
  await db.open();
  await seedLegacyCityProjection();
  useGtfsDataStore.setState({ syncing: false } as any);
});

describe("useTransitLegGeometry", () => {
  it("empty DB → endpoints + pending", async () => {
    const { result } = renderHook(() =>
      useTransitLegGeometry(LEG, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }),
    );
    await act(() => Promise.resolve());
    expect(result.current.source).toBe("endpoints");
    expect(result.current.pending).toBe(true);
  });

  it("after route+stops → intermediate", async () => {
    const { result } = renderHook(() =>
      useTransitLegGeometry(LEG, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }),
    );
    await act(async () => {
      await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
      await db.gtfsStops.bulkPut([
        { id: "A", name: "A", lat: 54.1, lon: 25.1 },
        { id: "B", name: "B", lat: 54.2, lon: 25.2 },
        { id: "C", name: "C", lat: 54.3, lon: 25.3 },
      ]);
    });
    await waitForLiveQuery(() => result.current, (v) => v.source === "intermediate");
    expect(result.current.source).toBe("intermediate");
  });

  it("single-transaction shapes write → direct jump to shape", async () => {
    // The polyline below decodes to the canonical Google example points
    // (38.5, -120.2) → (40.7, -120.95) → (43.252, -126.453). Pass
    // from/to locations that snap to opposite ends so `sliceShapeForLeg`
    // returns the full polyline rather than a degenerate 1-point slice.
    const { result } = renderHook(() =>
      useTransitLegGeometry(LEG, { lat: 38.5, lon: -120.2 }, { lat: 43.252, lon: -126.453 }),
    );
    await act(async () => {
      await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
      await db.gtfsStops.bulkPut([
        { id: "A", name: "A", lat: 54.1, lon: 25.1 },
        { id: "B", name: "B", lat: 54.2, lon: 25.2 },
        { id: "C", name: "C", lat: 54.3, lon: 25.3 },
      ]);
      await db.transaction("rw", [db.gtfsTrips, db.gtfsShapes], async () => {
        await db.gtfsTrips.put({
          tripId: "T1",
          routeId: "R1",
          serviceId: "S",
          headsign: "",
          departureSecs: [0, 60, 120],
          shapeId: "SHP",
        });
        await db.gtfsShapes.put({
          shapeId: "SHP",
          encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
          source: "gtfs",
        });
      });
    });
    const latest = await waitForLiveQuery(() => result.current, (v) => v.source === "shape");
    expect(latest.source).toBe("shape");
  });

  it("shape-less feed: intermediate + pending=false + no error logs", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useTransitLegGeometry(LEG, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }),
    );
    await act(async () => {
      await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
      await db.gtfsTrips.put({
        tripId: "T1",
        routeId: "R1",
        serviceId: "S",
        headsign: "",
        departureSecs: [0, 60, 120],
      });
      await db.gtfsStops.bulkPut([
        { id: "A", name: "A", lat: 54.1, lon: 25.1 },
        { id: "B", name: "B", lat: 54.2, lon: 25.2 },
        { id: "C", name: "C", lat: 54.3, lon: 25.3 },
      ]);
    });
    await waitForLiveQuery(() => result.current, (v) => v.source === "intermediate");
    expect(result.current.pending).toBe(false);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("stable reference across unrelated re-renders", async () => {
    const { result, rerender } = renderHook(() =>
      useTransitLegGeometry(LEG, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }),
    );
    await act(async () => {
      await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
      await db.gtfsStops.bulkPut([
        { id: "A", name: "A", lat: 54.1, lon: 25.1 },
        { id: "B", name: "B", lat: 54.2, lon: 25.2 },
        { id: "C", name: "C", lat: 54.3, lon: 25.3 },
      ]);
    });
    await waitForLiveQuery(() => result.current, (v) => v.source === "intermediate");
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it("leg_geometry_source emits once per source across re-renders", async () => {
    const spy = vi.spyOn(errorReporter, "reportTelemetry").mockImplementation(() => {});
    const { result, rerender } = renderHook(() =>
      useTransitLegGeometry(LEG, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }),
    );
    await act(async () => {
      await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
      await db.gtfsTrips.put({
        tripId: "T1",
        routeId: "R1",
        serviceId: "S",
        headsign: "",
        departureSecs: [0, 60, 120],
      });
      await db.gtfsStops.bulkPut([
        { id: "A", name: "A", lat: 54.1, lon: 25.1 },
        { id: "B", name: "B", lat: 54.2, lon: 25.2 },
        { id: "C", name: "C", lat: 54.3, lon: 25.3 },
      ]);
    });
    await waitForLiveQuery(() => result.current, (v) => v.source === "intermediate");
    // Re-render several times with the same source → telemetry must not re-fire.
    rerender();
    rerender();
    rerender();
    rerender();
    rerender();
    const sourceCalls = spy.mock.calls.filter(
      (c) => c[0] === "leg_geometry_source" && (c[1] as any).source === "intermediate",
    );
    expect(sourceCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it("leg_geometry_time_to_tier_ms fires once on first reach of shape", async () => {
    const spy = vi.spyOn(errorReporter, "reportTelemetry").mockImplementation(() => {});
    // From/to must align with the polyline endpoints so the shape slice
    // produces ≥2 coords and the shape tier fires (see test above).
    const { result } = renderHook(() =>
      useTransitLegGeometry(LEG, { lat: 38.5, lon: -120.2 }, { lat: 43.252, lon: -126.453 }),
    );
    await act(async () => {
      await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
      await db.gtfsStops.bulkPut([
        { id: "A", name: "A", lat: 54.1, lon: 25.1 },
        { id: "B", name: "B", lat: 54.2, lon: 25.2 },
        { id: "C", name: "C", lat: 54.3, lon: 25.3 },
      ]);
      await db.transaction("rw", [db.gtfsTrips, db.gtfsShapes], async () => {
        await db.gtfsTrips.put({
          tripId: "T1",
          routeId: "R1",
          serviceId: "S",
          headsign: "",
          departureSecs: [0, 60, 120],
          shapeId: "SHP",
        });
        await db.gtfsShapes.put({
          shapeId: "SHP",
          encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
          source: "gtfs",
        });
      });
    });
    await waitForLiveQuery(() => result.current, (v) => v.source === "shape");
    const tierCalls = spy.mock.calls.filter(
      (c) => c[0] === "leg_geometry_time_to_tier_ms" && (c[1] as any).source === "shape",
    );
    expect(tierCalls).toHaveLength(1);
    const payload = tierCalls[0][1] as { source: string; tripId: string; ms: number };
    expect(payload.source).toBe("shape");
    expect(payload.tripId).toBe("T1");
    expect(typeof payload.ms).toBe("number");
    expect(payload.ms).toBeGreaterThanOrEqual(0);
    spy.mockRestore();
  });
});
