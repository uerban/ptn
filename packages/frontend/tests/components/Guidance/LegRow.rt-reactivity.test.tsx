import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LegRow } from "../../../src/components/Guidance/LegRow.tsx";
import { useRtStore } from "../../../src/stores/rtStore.ts";
import { I18nContext } from "../../../src/i18n/index.ts";
import type { Leg } from "@pt/shared";
import type { ReactNode } from "react";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const upcomingTransitLeg: Leg = {
  mode: "BUS",
  from: { name: "Stop A", location: { lat: 0, lon: 0 } },
  to: { name: "Stop B", location: { lat: 0, lon: 0 } },
  departureTime: "2026-04-25T10:08:00Z",
  arrivalTime: "2026-04-25T10:20:00Z",
  durationSeconds: 720,
  routeShortName: "5",
  headsign: "Downtown",
  tripId: "T1",
};

describe("LegRow — RT reactivity (D-009 / D-019)", () => {
  beforeEach(() => {
    useRtStore.setState({ updates: new Map() });
  });

  it("re-renders the +N min badge when an RT update arrives after mount", () => {
    render(<LegRow leg={upcomingTransitLeg} status="upcoming" />, { wrapper: Wrapper });
    expect(screen.queryByText(/\+\d+ min/)).toBeNull();

    act(() => {
      useRtStore.setState({
        updates: new Map([
          ["R1", [{ tripId: "T1", delaySeconds: 180, cancelled: false }]],
        ]),
      });
    });

    expect(screen.getByText("+3 min")).toBeInTheDocument();
  });

  it("removes the badge when the RT update clears the delay", () => {
    useRtStore.setState({
      updates: new Map([
        ["R1", [{ tripId: "T1", delaySeconds: 180, cancelled: false }]],
      ]),
    });
    render(<LegRow leg={upcomingTransitLeg} status="upcoming" />, { wrapper: Wrapper });
    expect(screen.getByText("+3 min")).toBeInTheDocument();

    act(() => {
      useRtStore.setState({
        updates: new Map([
          ["R1", [{ tripId: "T1", delaySeconds: 0, cancelled: false }]],
        ]),
      });
    });

    expect(screen.queryByText(/\+\d+ min/)).toBeNull();
  });
});
