import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Departure, LatLon, Stop } from "@pt/shared";
import { useStopContextRiderPrompt } from "../../src/hooks/useStopContextRiderPrompt.ts";

const NOW = new Date("2026-11-18T10:00:00Z");
const stop: Stop = { id: "s1", name: "Stop", location: { lat: 54.7, lon: 25.3 } };
const atStop: LatLon = { lat: 54.7001, lon: 25.3001 };
const farAway: LatLon = { lat: 54.72, lon: 25.33 };
const departures = [{
  tripId: "trip-1",
  routeShortName: "27",
  headsign: "Centre",
  scheduledTime: "2026-11-18T10:05:00Z",
}] as Departure[];

type Props = Parameters<typeof useStopContextRiderPrompt>[0];
const base: Props = { stop, departures, position: atStop, speed: 0, phase: "idle" };

describe("useStopContextRiderPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("offers the viewed trips when the rider leaves the stop at vehicle speed", () => {
    const { result, rerender } = renderHook((props: Props) => useStopContextRiderPrompt(props), { initialProps: base });
    expect(result.current.candidates).toEqual([]);
    rerender({ ...base, speed: 6 });
    expect(result.current.candidates.map((c) => c.tripId)).toEqual(["trip-1"]);
  });

  it("stays closed through later GPS fixes after dismissal", () => {
    const { result, rerender } = renderHook((props: Props) => useStopContextRiderPrompt(props), { initialProps: base });
    rerender({ ...base, speed: 6 });
    act(() => result.current.dismiss());
    for (const speed of [7, 8.5, 9]) {
      rerender({ ...base, speed });
      expect(result.current.candidates).toEqual([]);
    }
  });

  it("does not offer a stop the rider was never near", () => {
    const away = { ...base, position: farAway };
    const { result, rerender } = renderHook((props: Props) => useStopContextRiderPrompt(props), { initialProps: away });
    rerender({ ...away, speed: 12 });
    expect(result.current.candidates).toEqual([]);
  });

  it("still offers the stop after the rider has moved away from it", () => {
    const { result, rerender } = renderHook((props: Props) => useStopContextRiderPrompt(props), { initialProps: base });
    rerender({ ...base, position: farAway, speed: 12 });
    expect(result.current.candidates).toHaveLength(1);
  });

  it("clears the offer once guidance starts", () => {
    const { result, rerender } = renderHook((props: Props) => useStopContextRiderPrompt(props), { initialProps: base });
    rerender({ ...base, speed: 6 });
    rerender({ ...base, speed: 6, phase: "riderMode" });
    expect(result.current.candidates).toEqual([]);
  });
});
