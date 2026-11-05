import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StopPopup } from "../../src/components/Map/StopPopup.tsx";
import { I18nContext } from "../../src/i18n/index.ts";
import type { Departure } from "@pt/shared";
import type { ReactNode } from "react";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

describe("StopPopup", () => {
  const baseDeparture: Departure = {
    routeId: "r1", routeShortName: "1", routeColor: "e53935",
    mode: "BUS", headsign: "Centre",
    scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
    tripId: "t1",
  };

  it("renders stop name", () => {
    render(<StopPopup stopName="Test Stop" departures={[baseDeparture]} onSeeAll={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByText("Test Stop")).toBeDefined();
  });

  it("renders departure as a card with badge and headsign on separate rows", () => {
    render(<StopPopup stopName="Stop" departures={[baseDeparture]} onSeeAll={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("Centre")).toBeDefined();
  });

  it("limits visible routes to maxPopupLines (default 4)", () => {
    const deps = Array.from({ length: 6 }, (_, i) => ({
      ...baseDeparture,
      routeId: `r${i}`,
      routeShortName: `${i + 1}`,
      tripId: `t${i}`,
      scheduledTime: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
    }));
    render(<StopPopup stopName="Stop" departures={deps} onSeeAll={vi.fn()} />, { wrapper: Wrapper });
    const popup = screen.getByTestId("stop-popup");
    const badges = popup.querySelectorAll("[data-testid='route-badge']");
    expect(badges.length).toBe(4);
  });

  it("shows See all button", () => {
    const onSeeAll = vi.fn();
    render(<StopPopup stopName="Stop" departures={[baseDeparture]} onSeeAll={onSeeAll} />, { wrapper: Wrapper });
    screen.getByText("See all").click();
    expect(onSeeAll).toHaveBeenCalled();
  });

  it("shows cancelled text for cancelled departures", () => {
    const cancelled = { ...baseDeparture, cancelled: true };
    render(<StopPopup stopName="Stop" departures={[cancelled]} onSeeAll={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.getByText("Cancelled")).toBeDefined();
  });

  it("hides cancelled departures when an active alternative exists in the same group", () => {
    // Mixed group: cancelled at +5m, active at +10m. The rendered group
    // should show only the active departure — falling through to
    // g.departures (cancelled-included) only happens when ALL are
    // cancelled, not when any is.
    const cancelled = { ...baseDeparture, cancelled: true, tripId: "t-cancelled" };
    const active = {
      ...baseDeparture,
      tripId: "t-active",
      scheduledTime: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    render(<StopPopup stopName="Stop" departures={[cancelled, active]} onSeeAll={vi.fn()} />, { wrapper: Wrapper });
    expect(screen.queryByText("Cancelled")).toBeNull();
  });

  it("calls onLineClick with route info when LineCard is tapped", () => {
    const onLineClick = vi.fn();
    render(
      <StopPopup stopName="Stop" departures={[baseDeparture]} onSeeAll={vi.fn()} onLineClick={onLineClick} />,
      { wrapper: Wrapper },
    );
    const card = screen.getByTestId("line-card");
    card.click();
    expect(onLineClick).toHaveBeenCalledWith("r1", "1", "e53935", "Centre");
  });

  it("does not render LineCard as clickable when onLineClick is not provided", () => {
    render(
      <StopPopup stopName="Stop" departures={[baseDeparture]} onSeeAll={vi.fn()} />,
      { wrapper: Wrapper },
    );
    const card = screen.getByTestId("line-card");
    expect(card.getAttribute("role")).toBeNull();
  });

  it("triggers onLineClick via keyboard Enter on LineCard", () => {
    const onLineClick = vi.fn();
    render(
      <StopPopup stopName="Stop" departures={[baseDeparture]} onSeeAll={vi.fn()} onLineClick={onLineClick} />,
      { wrapper: Wrapper },
    );
    const card = screen.getByTestId("line-card");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onLineClick).toHaveBeenCalledWith("r1", "1", "e53935", "Centre");
  });

  it("triggers onLineClick via keyboard Space on LineCard", () => {
    const onLineClick = vi.fn();
    render(
      <StopPopup stopName="Stop" departures={[baseDeparture]} onSeeAll={vi.fn()} onLineClick={onLineClick} />,
      { wrapper: Wrapper },
    );
    const card = screen.getByTestId("line-card");
    fireEvent.keyDown(card, { key: " " });
    expect(onLineClick).toHaveBeenCalledWith("r1", "1", "e53935", "Centre");
  });

  it("calls onLineClick with correct route info for each group", () => {
    const dep2: Departure = {
      ...baseDeparture,
      routeId: "r2",
      routeShortName: "42",
      routeColor: "1e88e5",
      headsign: "North",
      tripId: "t2",
    };
    const onLineClick = vi.fn();
    render(
      <StopPopup stopName="Stop" departures={[baseDeparture, dep2]} onSeeAll={vi.fn()} onLineClick={onLineClick} />,
      { wrapper: Wrapper },
    );
    const cards = screen.getAllByTestId("line-card");
    expect(cards.length).toBe(2);
    cards[1].click();
    expect(onLineClick).toHaveBeenCalledWith("r2", "42", "1e88e5", "North");
  });
});
