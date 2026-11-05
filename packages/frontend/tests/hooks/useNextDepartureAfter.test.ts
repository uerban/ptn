import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Leg } from "@pt/shared";
import { useNextDepartureAfter } from "../../src/hooks/useNextDepartureAfter.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { lineThreeIndex } from "../helpers/lineThreeIndex.ts";

const ride: Leg = {
  mode: "BUS",
  from: { name: "Stop 1", stopId: "S1", location: { lat: 0, lon: 0 } },
  to: { name: "Stop 2", stopId: "S2", location: { lat: 0, lon: 0 } },
  departureTime: "2026-09-25T08:00:00Z",
  arrivalTime: "2026-09-25T08:10:00Z",
  durationSeconds: 600,
  routeShortName: "3",
  routeId: "R3",
  tripId: "T800",
};

describe("useNextDepartureAfter", () => {
  const realCity = useCityStore.getState().activeCity;

  beforeEach(() => {
    useCityStore.setState({ activeCity: { ...realCity, tz: "UTC" } });
    useGtfsDataStore.setState({ raptorIndex: lineThreeIndex });
  });

  afterEach(() => {
    useCityStore.setState({ activeCity: realCity });
    useGtfsDataStore.setState({ raptorIndex: null });
  });

  it("finds the same line's next departure from the same stop", () => {
    const { result } = renderHook(() => useNextDepartureAfter(ride, Date.parse("2026-09-25T08:00:00Z")));
    expect(result.current).toBe(Date.parse("2026-09-25T08:10:00Z"));
  });

  it("looks past the missed bus even when the next one is close", () => {
    const { result } = renderHook(() => useNextDepartureAfter(ride, Date.parse("2026-09-25T08:10:00Z")));
    expect(result.current).toBe(Date.parse("2026-09-25T08:25:00Z"));
  });

  it("has nothing to say when not asked, or without a timetable", () => {
    expect(renderHook(() => useNextDepartureAfter(ride, null)).result.current).toBeNull();
    useGtfsDataStore.setState({ raptorIndex: null });
    expect(renderHook(() => useNextDepartureAfter(ride, Date.parse("2026-09-25T08:00:00Z"))).result.current).toBeNull();
  });
});
