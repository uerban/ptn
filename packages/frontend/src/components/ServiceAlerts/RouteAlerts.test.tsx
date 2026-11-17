import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Alert, Itinerary, Leg } from "@pt/shared";
import { I18nContext } from "../../i18n/index.ts";
import {
  listAlerts,
  RouteAlertMarker,
  RouteAlertsForResult,
  RouteAlertsSummary,
} from "./RouteAlerts.tsx";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider
      value={{
        locale: "en",
        formattingLocale: "en",
        t: (key, fallback) => fallback ?? key,
        privacyReady: true,
        ensurePrivacyNamespace: () => {},
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    cause: "UNKNOWN_CAUSE",
    effect: "DETOUR",
    severity: "WARNING",
    header: [{ text: "Detour" }],
    description: [],
    url: [],
    activePeriods: [],
    informedEntities: [{ routeId: "R1" }],
    ...overrides,
  };
}

function ride(routeId: string, line: string): Leg {
  return {
    mode: "BUS",
    from: { name: "Stop A", stopId: "SA", location: { lat: 0, lon: 0 } },
    to: { name: "Stop B", stopId: "SB", location: { lat: 0, lon: 0 } },
    departureTime: "2026-11-08T10:05:00Z",
    arrivalTime: "2026-11-08T10:25:00Z",
    durationSeconds: 1200,
    routeId,
    routeShortName: line,
    tripId: `T-${routeId}`,
  };
}

const trip = (...legs: Leg[]) => ({ legs }) as Pick<Itinerary, "legs">;

afterEach(cleanup);

describe("listAlerts", () => {
  it("lists each alert once per list, merging lines, urgent first", () => {
    const detour = alert({ id: "detour", informedEntities: [{ routeId: "R1" }, { routeId: "R2" }] });
    const stop = alert({ id: "stop", severity: "INFO", effect: "NO_SERVICE", informedEntities: [{ routeId: "R2" }] });
    const result = listAlerts(
      [detour, stop],
      [trip(ride("R1", "3G")), trip(ride("R2", "7")), trip(ride("R1", "3G"))],
    );
    expect(result.all.map((e) => e.alert.id)).toEqual(["stop", "detour"]);
    expect(result.all.find((e) => e.alert.id === "detour")?.lines).toEqual(["3G", "7"]);
    expect(result.perItinerary.map((list) => list.map((e) => e.alert.id))).toEqual([
      ["detour"],
      ["detour", "stop"],
      ["detour"],
    ]);
    expect(result.firstAt.get("detour")).toBe(0);
    expect(result.firstAt.get("stop")).toBe(1);
  });
});

describe("RouteAlertsSummary", () => {
  it("renders nothing without alerts", () => {
    const { container } = render(<RouteAlertsSummary entries={[]} />, { wrapper: Wrapper });
    expect(container.innerHTML).toBe("");
  });

  it("keeps urgent alerts open and folds the rest behind one button", () => {
    const severe = { alert: alert({ id: "s", severity: "SEVERE", header: [{ text: "No trams" }] }), lines: ["1"] };
    const warn1 = { alert: alert({ id: "w1", header: [{ text: "Detour A" }] }), lines: ["3G"] };
    const warn2 = { alert: alert({ id: "w2", header: [{ text: "Detour B" }] }), lines: ["7"] };
    render(<RouteAlertsSummary entries={[severe, warn1, warn2]} />, { wrapper: Wrapper });

    expect(screen.getByText("No trams").closest("[hidden]")).toBeNull();
    const toggle = screen.getByTestId("route-alerts-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Alerts on these routes: 2");
    const list = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect((list as HTMLElement).hidden).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(list as HTMLElement).getByText("Detour A")).toBeTruthy();
    expect(within(list as HTMLElement).getByText("Detour B")).toBeTruthy();
  });

  it("uses the app font, not the result list's", () => {
    render(<RouteAlertsSummary entries={[{ alert: alert(), lines: [] }]} />, { wrapper: Wrapper });
    expect(screen.getByTestId("route-alerts-summary").classList.contains("font-sans")).toBe(true);
  });
});

describe("RouteAlertMarker", () => {
  it("names the affected lines for screen readers", () => {
    render(
      <RouteAlertMarker entries={[{ alert: alert(), lines: ["3G"] }, { alert: alert({ id: "b" }), lines: ["3G", "7"] }]} />,
      { wrapper: Wrapper },
    );
    const marker = screen.getByTestId("route-alert-marker");
    expect(marker.textContent).toContain("Service alert affects line 3G, 7");
  });
});

describe("RouteAlertsForResult", () => {
  it("shows an alert in full on its first result and points back on later ones", () => {
    const entry = { alert: alert({ header: [{ text: "Detour" }] }), lines: ["3G"] };
    const firstAt = new Map([["a1", 0]]);
    render(
      <>
        <RouteAlertsForResult entries={[entry]} index={0} firstAt={firstAt} />
        <RouteAlertsForResult entries={[entry]} index={1} firstAt={firstAt} />
      </>,
      { wrapper: Wrapper },
    );
    expect(screen.getAllByTestId("service-alert")).toHaveLength(1);
    expect(screen.getByTestId("route-alert-repeat").textContent).toContain("Same alert as above");
  });
});
