import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { LineGroup } from "../../src/components/DepartureSheet/LineGroup.tsx";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const baseDep = {
  routeId: "r1",
  routeShortName: "1",
  routeColor: "e53935",
  mode: "BUS" as const,
  headsign: "Centre",
  scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
  tripId: "t1",
};

describe("LineGroup", () => {
  it("renders view-route button when onLineClick and routeId are provided", () => {
    render(
      <LineGroup
        routeShortName="1"
        routeColor="e53935"
        mode="BUS"
        headsign="Centre"
        departures={[baseDep]}
        routeId="r1"
        onLineClick={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByTestId("view-route-btn")).toBeDefined();
  });

  it("does not render view-route button when onLineClick is not provided", () => {
    render(
      <LineGroup
        routeShortName="1"
        routeColor="e53935"
        mode="BUS"
        headsign="Centre"
        departures={[baseDep]}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("view-route-btn")).toBeNull();
  });

  it("calls onLineClick with correct routeId when view-route button is clicked", () => {
    const onLineClick = vi.fn();
    render(
      <LineGroup
        routeShortName="1"
        routeColor="e53935"
        mode="BUS"
        headsign="Centre"
        departures={[baseDep]}
        routeId="r1"
        onLineClick={onLineClick}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("view-route-btn"));
    expect(onLineClick).toHaveBeenCalledWith("r1", "1", "e53935", "Centre");
  });

  it("does not render view-route button when routeId is missing", () => {
    render(
      <LineGroup
        routeShortName="1"
        routeColor="e53935"
        mode="BUS"
        headsign="Centre"
        departures={[baseDep]}
        onLineClick={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByTestId("view-route-btn")).toBeNull();
  });

  it("does not toggle expansion when view-route button is clicked", () => {
    render(
      <LineGroup
        routeShortName="1"
        routeColor="e53935"
        mode="BUS"
        headsign="Centre"
        departures={[baseDep]}
        routeId="r1"
        onLineClick={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    fireEvent.click(screen.getByTestId("view-route-btn"));
    // Schedule rows only appear when expanded
    expect(screen.queryByTestId("schedule-row")).toBeNull();
  });

  it("shades every other expanded row so long schedules stay easy to follow", () => {
    const deps = [5, 15, 25, 35].map((m, i) => ({
      ...baseDep,
      tripId: `t${i}`,
      scheduledTime: new Date(Date.now() + m * 60_000).toISOString(),
    }));
    const { container } = render(
      <LineGroup routeShortName="1" routeColor="e53935" mode="BUS" headsign="Centre" departures={deps} />,
      { wrapper: Wrapper },
    );
    fireEvent.click(container.querySelector("[aria-expanded]")!);
    const rows = screen.getAllByTestId("schedule-row");
    expect(rows.map((r) => r.hasAttribute("data-striped"))).toEqual([false, true, false, true]);
  });

  it("shows waits of an hour or more as hours and minutes, not a clock time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 19, 0, 30));
    try {
      const deps = [{ ...baseDep, scheduledTime: new Date(Date.now() + 70 * 60_000).toISOString() }];
      const { container } = render(
        <LineGroup routeShortName="1" routeColor="e53935" mode="BUS" headsign="Centre" departures={deps} />,
        { wrapper: Wrapper },
      );
      fireEvent.click(container.querySelector("[aria-expanded]")!);
      const row = screen.getByTestId("schedule-row");
      // The departure clock legitimately contains 1:40; only the wait is a duration.
      expect(within(row).getByTestId("scheduled-time").textContent).toMatch(/1:40/);
      expect(within(row).getByText("1 h 10 min").textContent).toBe("1\u00a0h 10\u00a0min");
    } finally {
      vi.useRealTimers();
    }
  });
});
