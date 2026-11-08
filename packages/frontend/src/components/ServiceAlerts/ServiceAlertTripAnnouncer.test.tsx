import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Alert, Itinerary } from "@pt/shared";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGuidanceStore } from "../../stores/guidanceStore.ts";
import { useNetworkDecisionsStore } from "../../stores/networkDecisionsStore.ts";
import { recordRealtimeHeader } from "../../services/realtimeAvailability.ts";
import {
  __resetServiceAlertsForTests,
  SERVICE_ALERTS_FLOW_ID,
  SERVICE_ALERTS_POLL_MS,
} from "../../services/serviceAlertsClient.ts";
import { ServiceAlertTripAnnouncer } from "./ServiceAlertTripAnnouncer.tsx";

const CITY = "vilnius";

const TRIP: Itinerary = {
  legs: [
    {
      mode: "BUS",
      from: { name: "A", stopId: "SA", location: { lat: 0, lon: 0 } },
      to: { name: "B", stopId: "SB", location: { lat: 0, lon: 0 } },
      departureTime: "2026-11-08T10:05:00Z",
      arrivalTime: "2026-11-08T10:25:00Z",
      durationSeconds: 1200,
      routeId: "R1",
      routeShortName: "4G",
      tripId: "T1",
    },
  ],
  departureTime: "2026-11-08T10:05:00Z",
  arrivalTime: "2026-11-08T10:25:00Z",
  durationSeconds: 1200,
  transfers: 0,
} as Itinerary;

function alert(id: string, severity: Alert["severity"]): Alert {
  return {
    id,
    cause: "ACCIDENT",
    effect: "NO_SERVICE",
    severity,
    header: [{ text: `Header ${id}` }],
    description: [],
    url: [],
    activePeriods: [],
    informedEntities: [{ routeId: "R1" }],
  };
}

let alerts: Alert[] = [];
const fetchMock = vi.fn(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        schemaVersion: 1,
        city: CITY,
        fetchedAt: new Date().toISOString(),
        stale: false,
        alerts,
      }),
      { status: 200 },
    ),
  ),
);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  alerts = [];
  useNetworkDecisionsStore.getState().reset();
  useNetworkDecisionsStore.getState().setDecision(SERVICE_ALERTS_FLOW_ID, "allowed", "settings");
  recordRealtimeHeader(CITY, "alerts");
  useCityStore.setState((s) => ({ activeCity: { ...s.activeCity, id: CITY } }));
  __resetServiceAlertsForTests({ fetch: fetchMock as unknown as typeof fetch });
  useGuidanceStore.setState({ phase: "navigating", itinerary: TRIP });
});

afterEach(() => {
  cleanup();
  __resetServiceAlertsForTests();
  useGuidanceStore.setState({ phase: "idle", itinerary: null });
  vi.useRealTimers();
});

describe("ServiceAlertTripAnnouncer", () => {
  it("politely announces a severe alert on the trip, once", async () => {
    alerts = [alert("w", "WARNING")];
    render(<ServiceAlertTripAnnouncer />);
    await act(async () => {});
    const region = screen.getByTestId("service-alert-trip-announcer");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");

    alerts = [alert("w", "WARNING"), alert("s", "SEVERE")];
    await act(async () => {
      vi.advanceTimersByTime(SERVICE_ALERTS_POLL_MS);
    });
    expect(region.textContent).toBe("Severe service alert on your trip: Header s");

    // The same alert again is not announced again.
    region.textContent = "";
    await act(async () => {
      vi.advanceTimersByTime(SERVICE_ALERTS_POLL_MS);
    });
    expect(region.textContent).toBe("");
  });
});
