import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import type { Alert, Itinerary } from "@pt/shared";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";

const ALERT: Alert = {
  id: "a1",
  cause: "UNKNOWN_CAUSE",
  effect: "DETOUR",
  severity: "WARNING",
  header: [{ text: "Eismo situacija" }],
  description: [],
  url: [],
  activePeriods: [],
  informedEntities: [{ routeId: "R1" }],
};
const ENTRY = { alert: ALERT, lines: ["3G"] };

// The alert lookup itself is covered in RouteAlerts.test.tsx; here every
// result shares one alert so placement and de-duplication are visible.
vi.mock("../../src/components/ServiceAlerts/RouteAlerts.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/components/ServiceAlerts/RouteAlerts.tsx")>();
  return {
    ...actual,
    useListAlerts: (its: readonly Itinerary[]) => ({
      all: [ENTRY],
      perItinerary: its.map(() => [ENTRY]),
      firstAt: new Map([["a1", 0]]),
    }),
  };
});

const { RouteResultsPower } = await import("../../src/components/RouteResults/RouteResultsPower.tsx");
const { RouteResultsConsumer } = await import("../../src/components/RouteResults/RouteResultsConsumer.tsx");
const { RouteResultsAccessible } = await import("../../src/components/RouteResults/RouteResultsAccessible.tsx");

function itinerary(): Itinerary {
  return {
    legs: [
      {
        mode: "BUS",
        from: { name: "A", location: { lat: 0, lon: 0 } },
        to: { name: "B", location: { lat: 0, lon: 0 } },
        departureTime: "2026-03-03T10:00:00Z",
        arrivalTime: "2026-03-03T10:15:00Z",
        durationSeconds: 900,
        routeId: "R1",
        routeShortName: "3G",
      },
    ],
    departureTime: "2026-03-03T10:00:00Z",
    arrivalTime: "2026-03-03T10:15:00Z",
    durationSeconds: 900,
    transfers: 0,
    walkingDistanceMeters: 200,
  };
}

const props = {
  itineraries: [itinerary(), itinerary()],
  onSelect: () => {},
  referenceNowMs: Date.parse("2026-03-03T09:50:00Z"),
  bufferSeconds: 0,
};

function renderIn(ui: React.ReactElement) {
  return render(
    <BrowserRouter>
      <I18nProvider>{ui}</I18nProvider>
    </BrowserRouter>,
  );
}

const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

afterEach(cleanup);

describe("service alerts in route results", () => {
  it("Power: one alert strip above the legend, then results, then a marker per result", () => {
    renderIn(<RouteResultsPower {...props} />);
    expect(screen.getAllByText("Eismo situacija")).toHaveLength(1);
    const strip = screen.getByTestId("route-alerts-summary");
    const legend = screen.getByText("DEP → ARR");
    const list = screen.getByRole("list", { name: /route results/i });
    expect(follows(strip, legend)).toBe(true);
    expect(follows(legend, list)).toBe(true);
    expect(list.contains(strip)).toBe(false);
    expect(screen.getAllByTestId("route-alert-marker")).toHaveLength(2);
  });

  it("Consumer: one strip before the list, markers after each card", () => {
    renderIn(<RouteResultsConsumer {...props} />);
    const strip = screen.getByTestId("route-alerts-summary");
    const list = screen.getByRole("list", { name: /route results/i });
    expect(follows(strip, list)).toBe(true);
    const markers = screen.getAllByTestId("route-alert-marker");
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      const card = marker.closest("li")?.querySelector("button");
      expect(card && follows(card, marker)).toBe(true);
    }
  });

  it("Accessible: full alert on the first result, a pointer back on the next", () => {
    renderIn(<RouteResultsAccessible {...props} />);
    expect(screen.queryByTestId("route-alerts-summary")).toBeNull();
    expect(screen.getAllByTestId("service-alert")).toHaveLength(1);
    expect(screen.getAllByTestId("route-alert-repeat")).toHaveLength(1);
  });
});
