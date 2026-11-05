import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { ETACards, type EtaStopInfo } from "../../src/components/Map/ETACards.tsx";
import { I18nContext } from "../../src/i18n/index.ts";
import type { Side } from "../../src/services/nearbyDirections.ts";
import type { Departure, StopWithLines } from "@pt/shared";
import type { ComponentProps, ReactNode } from "react";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const STOP: StopWithLines = {
  id: "s1",
  name: "Stop A",
  location: { lat: 54.687, lon: 25.279 },
  lastSeen: 0,
};

const noop = () => {};

type Props = ComponentProps<typeof ETACards>;

/**
 * One `top` side per route at `stop`, in order of first departure: the shape
 * the hook falls back to without a pattern index, i.e. today's single row.
 */
function oneRow(departures: Departure[], stop: StopWithLines = STOP): Pick<Props, "sides" | "departuresBySide"> {
  const sides: Side[] = [];
  const departuresBySide = new Map<Side, Departure[]>();
  for (const d of departures) {
    let side = sides.find((s) => s.routeId === d.routeId);
    if (!side) {
      side = { stopId: stop.id, routeId: d.routeId, dirKey: "*", row: "top" };
      sides.push(side);
      departuresBySide.set(side, []);
    }
    departuresBySide.get(side)!.push(d);
  }
  return { sides, departuresBySide };
}

/** Full props for a single-row strip at `STOP`. */
function stripProps(departures: Departure[], overrides: Partial<Props> = {}): Props {
  return {
    ...oneRow(departures),
    nearestStop: STOP,
    stopInfo: new Map<string, EtaStopInfo>([[STOP.id, { stop: STOP, distanceM: 40 }]]),
    loading: false,
    layout: "rows",
    onSelect: noop,
    ...overrides,
  };
}

function makeDeparture(overrides: Partial<Departure> = {}): Departure {
  return {
    routeId: "r1",
    routeShortName: "1",
    routeColor: "e53935",
    mode: "BUS",
    headsign: "Centre",
    scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
    tripId: "t1",
    ...overrides,
  };
}

// Two-sided street, shared by both layouts: lines 1 and 2 at S ("Main St",
// the user's side) and at R, the same-name pole across the road. Line 3 is an
// extra: it serves R2 ("Side St") on the far side, and its other direction
// leaves from T ("Park") on the near side.
const S: StopWithLines = { id: "S", name: "Main St", location: { lat: 54.687, lon: 25.279 }, lastSeen: 0 };
const R: StopWithLines = { id: "R", name: "Main St", location: { lat: 54.6871, lon: 25.2793 }, lastSeen: 0 };
const R2: StopWithLines = { id: "R2", name: "Side St", location: { lat: 54.6874, lon: 25.2795 }, lastSeen: 0 };
const T: StopWithLines = { id: "T", name: "Park", location: { lat: 54.6866, lon: 25.2786 }, lastSeen: 0 };

const INFO = new Map<string, EtaStopInfo>([
  ["S", { stop: S, distanceM: 12.4 }],
  ["R", { stop: R, distanceM: 25 }],
  ["R2", { stop: R2, distanceM: 60 }],
  ["T", { stop: T, distanceM: 80 }],
]);

const S1: Side = { stopId: "S", routeId: "r1", dirKey: "d0", row: "top" };
const S2: Side = { stopId: "S", routeId: "r2", dirKey: "d0", row: "top" };
const R1: Side = { stopId: "R", routeId: "r1", dirKey: "d1", row: "bottom" };
const RR2: Side = { stopId: "R", routeId: "r2", dirKey: "d1", row: "bottom" };
const X3: Side = { stopId: "R2", routeId: "r3", dirKey: "d0", row: "bottom" };
const T3: Side = { stopId: "T", routeId: "r3", dirKey: "d1", row: "top" };
// Resolver order: top seeds, their reverses, extras, the extras' reverses.
const SIDES = [S1, S2, R1, RR2, X3, T3];

function inMin(mins: number): string {
  // A second short of the minute, so the ceil'd countdown reads `mins`.
  return new Date(Date.now() + mins * 60_000 - 1_000).toISOString();
}

function line(routeId: string, headsign: string, mins: number, tripId = `${routeId}-${headsign}-${mins}`): Departure {
  return makeDeparture({
    routeId, routeShortName: routeId.slice(1), headsign, tripId, scheduledTime: inMin(mins),
  });
}

function streetDepartures(): Map<Side, Departure[]> {
  return new Map<Side, Departure[]>([
    [S1, [line("r1", "Airport", 3)]],
    [S2, [line("r2", "Zoo", 7)]],
    [R1, [line("r1", "Centre", 4)]],
    [RR2, [line("r2", "Harbour", 2)]],
    [X3, [line("r3", "Park", 9)]],
    [T3, [line("r3", "Old Town", 5)]],
  ]);
}

function streetProps(overrides: Partial<Props> = {}): Props {
  return {
    sides: SIDES,
    departuresBySide: streetDepartures(),
    nearestStop: S,
    stopInfo: INFO,
    loading: false,
    layout: "rows",
    onSelect: noop,
    ...overrides,
  };
}

const pillLines = (el: HTMLElement) =>
  within(el).getAllByTestId("eta-route-badge").map((b) => b.textContent);

describe("ETACards", () => {
  it("renders nothing when loading", () => {
    const { container } = render(
      <ETACards {...stripProps([makeDeparture()], { loading: true })} />,
      { wrapper: Wrapper },
    );
    expect(container.querySelector("[data-testid='eta-cards']")).toBeNull();
  });

  it("renders nothing when no departures", () => {
    const { container } = render(
      <ETACards {...stripProps([])} />,
      { wrapper: Wrapper },
    );
    expect(container.querySelector("[data-testid='eta-cards']")).toBeNull();
  });

  it("renders cards for departures", () => {
    const deps = [
      makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Centre", tripId: "t1" }),
      makeDeparture({
        routeId: "r2", routeShortName: "42", headsign: "North", tripId: "t2",
        scheduledTime: new Date(Date.now() + 8 * 60_000).toISOString(),
      }),
    ];
    render(<ETACards {...stripProps(deps)} />, { wrapper: Wrapper });
    expect(screen.getByTestId("eta-cards")).toBeDefined();
    const cards = screen.getAllByTestId("eta-card");
    expect(cards.length).toBe(2);
  });

  it("displays route badge and headsign", () => {
    render(
      <ETACards {...stripProps([makeDeparture()])} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("Centre")).toBeDefined();
  });

  it("displays countdown text", () => {
    const dep = makeDeparture({
      scheduledTime: new Date(Date.now() + 3 * 60_000).toISOString(),
    });
    render(<ETACards {...stripProps([dep])} />, { wrapper: Wrapper });
    const countdown = screen.getByTestId("eta-countdown");
    // Should show minutes (could be 3 or 4 depending on rounding)
    expect(countdown.textContent).toMatch(/\d+ min/);
  });

  it("shows Due for departures arriving now", () => {
    const dep = makeDeparture({
      scheduledTime: new Date(Date.now() - 10_000).toISOString(),
    });
    render(<ETACards {...stripProps([dep])} />, { wrapper: Wrapper });
    expect(screen.getByText("Due")).toBeDefined();
  });

  it("deduplicates same route+headsign to show only the soonest", () => {
    const deps = [
      makeDeparture({
        routeId: "r1", headsign: "Centre", tripId: "t1",
        scheduledTime: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
      makeDeparture({
        routeId: "r1", headsign: "Centre", tripId: "t2",
        scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    ];
    render(<ETACards {...stripProps(deps)} />, { wrapper: Wrapper });
    const cards = screen.getAllByTestId("eta-card");
    expect(cards.length).toBe(1);
  });

  it("excludes cancelled departures", () => {
    const deps = [
      makeDeparture({ cancelled: true }),
    ];
    const { container } = render(
      <ETACards {...stripProps(deps)} />,
      { wrapper: Wrapper },
    );
    expect(container.querySelector("[data-testid='eta-cards']")).toBeNull();
  });

  it("ranks groups by next active departure even when another group has an earlier cancellation", () => {
    // Group A's only-soon departure is cancelled; its next active is at +15m.
    // Group B has an active departure at +5m and should render first.
    // Pre-fix, the helper sorted Group A first because its earliest departure
    // (the cancelled one at +1m) won the between-group sort, so the carousel
    // mis-ordered active cards.
    const deps = [
      makeDeparture({
        routeId: "r-a", routeShortName: "A", headsign: "North",
        tripId: "a-cancelled", cancelled: true,
        scheduledTime: new Date(Date.now() + 1 * 60_000).toISOString(),
      }),
      makeDeparture({
        routeId: "r-a", routeShortName: "A", headsign: "North",
        tripId: "a-active",
        scheduledTime: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
      makeDeparture({
        routeId: "r-b", routeShortName: "B", headsign: "South",
        tripId: "b-active",
        scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    ];
    render(<ETACards {...stripProps(deps)} />, { wrapper: Wrapper });
    const cards = screen.getAllByTestId("eta-card");
    expect(cards.length).toBe(2);
    // First card = the soonest active (B at +5m), not A's later +15m active.
    expect(cards[0].textContent).toContain("B");
    expect(cards[1].textContent).toContain("A");
  });

  it("renders at most 10 cards", () => {
    const deps = Array.from({ length: 15 }, (_, i) =>
      makeDeparture({
        routeId: `r${i}`,
        routeShortName: `${i + 1}`,
        headsign: `Dir${i}`,
        tripId: `t${i}`,
        scheduledTime: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
      }),
    );
    render(<ETACards {...stripProps(deps)} />, { wrapper: Wrapper });
    const cards = screen.getAllByTestId("eta-card");
    expect(cards.length).toBe(10);
  });

  describe("pill as a button", () => {
    it("renders each pill as a native button labelled with line, headsign, stop and minutes", () => {
      const dep = makeDeparture({
        routeShortName: "1", headsign: "Centre",
        scheduledTime: new Date(Date.now() + 5 * 60_000 - 1_000).toISOString(),
      });
      render(<ETACards {...stripProps([dep])} />, { wrapper: Wrapper });
      const pill = screen.getByTestId("eta-card");
      expect(pill.tagName).toBe("BUTTON");
      expect(pill.getAttribute("type")).toBe("button");
      expect(pill.getAttribute("aria-label")).toBe("Line 1 toward Centre, from Stop A, in 5 min");
      expect(screen.getByRole("button", { name: "Line 1 toward Centre, from Stop A, in 5 min" })).toBe(pill);
    });

    it("labels a due departure without a minute count", () => {
      const dep = makeDeparture({ scheduledTime: new Date(Date.now() - 10_000).toISOString() });
      render(<ETACards {...stripProps([dep])} />, { wrapper: Wrapper });
      expect(screen.getByTestId("eta-card").getAttribute("aria-label"))
        .toBe("Line 1 toward Centre, from Stop A, due now");
    });

    it("builds the label from the eta.pill_aria translation", () => {
      const translations: Record<string, string> = {
        "eta.pill_aria": "{line} → {headsign} @ {stop} ({minutes})",
        "eta.pill_aria_due": "{line} → {headsign} @ {stop} (now)",
      };
      const t = (key: string, fallback?: string) => translations[key] ?? fallback ?? key;
      const deps = [
        makeDeparture({
          routeId: "r1", routeShortName: "1", headsign: "Centre", tripId: "t1",
          scheduledTime: new Date(Date.now() + 5 * 60_000 - 1_000).toISOString(),
        }),
        makeDeparture({
          routeId: "r2", routeShortName: "$&", headsign: "{stop}", tripId: "t2",
          scheduledTime: new Date(Date.now() - 10_000).toISOString(),
        }),
      ];
      render(
        <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t }}>
          <ETACards {...stripProps(deps)} />
        </I18nContext.Provider>,
      );
      const labels = screen.getAllByTestId("eta-card").map((c) => c.getAttribute("aria-label"));
      // Values are inserted literally: "$&" is not a replace pattern and a
      // headsign that reads "{stop}" is not a placeholder.
      expect(labels).toEqual(["$& → {stop} @ Stop A (now)", "1 → Centre @ Stop A (5)"]);
    });

    it("calls onSelect with the pill's departure and the stop on click", () => {
      const onSelect = vi.fn();
      const later = makeDeparture({
        routeId: "r1", headsign: "Centre", tripId: "t-later",
        scheduledTime: new Date(Date.now() + 12 * 60_000).toISOString(),
      });
      const soonest = makeDeparture({
        routeId: "r1", headsign: "Centre", tripId: "t-soonest",
        scheduledTime: new Date(Date.now() + 4 * 60_000).toISOString(),
      });
      const cancelled = makeDeparture({
        routeId: "r1", headsign: "Centre", tripId: "t-cancelled", cancelled: true,
        scheduledTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      });
      render(
        <ETACards {...stripProps([later, cancelled, soonest], { onSelect })} />,
        { wrapper: Wrapper },
      );
      fireEvent.click(screen.getByTestId("eta-card"));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls[0][0]).toBe(soonest);
      expect(onSelect.mock.calls[0][1]).toBe(STOP);
    });

    it("calls onSelect for the pill that was clicked", () => {
      const onSelect = vi.fn();
      const a = makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Centre", tripId: "t-a" });
      const b = makeDeparture({
        routeId: "r2", routeShortName: "42", headsign: "North", tripId: "t-b",
        scheduledTime: new Date(Date.now() + 8 * 60_000).toISOString(),
      });
      render(<ETACards {...stripProps([a, b], { onSelect })} />, { wrapper: Wrapper });
      fireEvent.click(screen.getAllByTestId("eta-card")[1]);
      expect(onSelect).toHaveBeenCalledWith(b, STOP);
    });

    // Enter and Space activate a native button through its own click event,
    // which jsdom does not synthesize from key events. A key handler of the
    // pill's own would be a second path to `onSelect` (Space clicks on key-up
    // in some browsers whatever key-down did), so there must be none: keys
    // reach `onSelect` only through that one click.
    it.each([["Enter", "Enter"], ["Space", " "], ["Tab", "Tab"]])(
      "leaves %s to the native button: the key alone never selects",
      (_name, key) => {
        const onSelect = vi.fn();
        render(<ETACards {...stripProps([makeDeparture()], { onSelect })} />, { wrapper: Wrapper });
        const pill = screen.getByTestId("eta-card");
        expect(pill.tagName).toBe("BUTTON");
        fireEvent.keyDown(pill, { key });
        fireEvent.keyUp(pill, { key });
        expect(onSelect).not.toHaveBeenCalled();
      },
    );

    it("carries its strip key, for Home to return focus to it", () => {
      const departuresBySide = streetDepartures();
      render(<ETACards {...streetProps({ departuresBySide })} />, { wrapper: Wrapper });
      const keys = screen.getAllByTestId("eta-card").map((p) => p.getAttribute("data-pill-key"));
      expect(keys).toContain("S::r1::d0::Airport");
      expect(keys).toContain("R2::r3::d0::Park");
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("keeps the route badge inside the button", () => {
      render(<ETACards {...stripProps([makeDeparture()])} />, { wrapper: Wrapper });
      const pill = screen.getByTestId("eta-card");
      const badge = screen.getByTestId("eta-route-badge");
      expect(pill.contains(badge)).toBe(true);
      expect(badge.textContent).toBe("1");
      expect(badge.style.background).not.toBe("");
    });
  });

  describe("rows layout", () => {
    it("renders two rows, each a group labelled by its header", () => {
      render(<ETACards {...streetProps()} />, { wrapper: Wrapper });
      const headers = screen.getAllByTestId("eta-row-header").map((h) => h.textContent);
      expect(headers).toEqual(["Main St · 12 m", "Opposite direction · Main St · 25 m"]);
      const top = screen.getByRole("group", { name: "Main St · 12 m" });
      const bottom = screen.getByRole("group", { name: "Opposite direction · Main St · 25 m" });
      expect(top.getAttribute("data-row")).toBe("top");
      expect(bottom.getAttribute("data-row")).toBe("bottom");
    });

    it("orders each row soonest first, across its sides", () => {
      render(<ETACards {...streetProps()} />, { wrapper: Wrapper });
      const [top, bottom] = screen.getAllByTestId("eta-row");
      // Top: 1 (3 min at S), 3 (5 min at T), 2 (7 min at S).
      expect(pillLines(top)).toEqual(["1", "3", "2"]);
      // Bottom: 2 (2 min at R), 1 (4 min at R), 3 (9 min at R2).
      expect(pillLines(bottom)).toEqual(["2", "1", "3"]);
    });

    it("shows a pill's stop name only when it differs from the row's main stop", () => {
      render(<ETACards {...streetProps()} />, { wrapper: Wrapper });
      const [top, bottom] = screen.getAllByTestId("eta-row");
      const topPills = within(top).getAllByTestId("eta-card");
      const bottomPills = within(bottom).getAllByTestId("eta-card");
      // Top row's main stop is S; line 3 leaves from T.
      expect(within(topPills[0]).queryByTestId("eta-pill-stop")).toBeNull();
      expect(within(topPills[1]).getByTestId("eta-pill-stop").textContent).toBe("Park");
      expect(within(topPills[2]).queryByTestId("eta-pill-stop")).toBeNull();
      // Bottom row's main stop is R (two sides); line 3 leaves from R2.
      expect(within(bottomPills[0]).queryByTestId("eta-pill-stop")).toBeNull();
      expect(within(bottomPills[1]).queryByTestId("eta-pill-stop")).toBeNull();
      expect(within(bottomPills[2]).getByTestId("eta-pill-stop").textContent).toBe("Side St");
    });

    it("hides the stop name of a different stop that carries the same name", () => {
      const info = new Map(INFO);
      info.set("R2", { stop: { ...R2, name: "Main St" }, distanceM: 60 });
      render(<ETACards {...streetProps({ stopInfo: info })} />, { wrapper: Wrapper });
      const bottom = screen.getAllByTestId("eta-row")[1];
      expect(within(bottom).queryByTestId("eta-pill-stop")).toBeNull();
    });

    it("names the bottom row after its first side's stop when the stops tie", () => {
      // Junction split: line 1 reverses at R, line 2 at R2, one side each.
      const r2: Side = { stopId: "R2", routeId: "r2", dirKey: "d1", row: "bottom" };
      const departuresBySide = new Map<Side, Departure[]>([
        [S1, [line("r1", "Airport", 3)]],
        [S2, [line("r2", "Zoo", 7)]],
        [R1, [line("r1", "Centre", 4)]],
        [r2, [line("r2", "Harbour", 2)]],
      ]);
      render(
        <ETACards {...streetProps({ sides: [S1, S2, R1, r2], departuresBySide })} />,
        { wrapper: Wrapper },
      );
      expect(screen.getAllByTestId("eta-row-header")[1].textContent)
        .toBe("Opposite direction · Main St · 25 m");
      const bottom = screen.getAllByTestId("eta-row")[1];
      // Line 2 (2 min) leaves from R2, not the header's stop.
      expect(within(bottom).getByTestId("eta-pill-stop").textContent).toBe("Side St");
    });

    it("labels and selects a pill with its own stop", () => {
      const onSelect = vi.fn();
      const departuresBySide = streetDepartures();
      const [extra] = departuresBySide.get(X3)!;
      render(<ETACards {...streetProps({ departuresBySide, onSelect })} />, { wrapper: Wrapper });
      const bottom = screen.getAllByTestId("eta-row")[1];
      const pill = within(bottom).getAllByTestId("eta-card")[2];
      expect(pill.getAttribute("aria-label")).toBe("Line 3 toward Park, from Side St, in 9 min");
      fireEvent.click(pill);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls[0][0]).toBe(extra);
      expect(onSelect.mock.calls[0][1]).toBe(R2);
    });

    it("groups a side's departures by route and headsign, soonest per group", () => {
      const departuresBySide = streetDepartures();
      departuresBySide.set(S1, [
        line("r1", "Airport", 8, "late"),
        line("r1", "Depot", 6),
        line("r1", "Airport", 3, "soon"),
      ]);
      render(<ETACards {...streetProps({ departuresBySide })} />, { wrapper: Wrapper });
      const top = screen.getAllByTestId("eta-row")[0];
      const pills = within(top).getAllByTestId("eta-card");
      expect(pills.map((p) => p.getAttribute("aria-label"))).toEqual([
        "Line 1 toward Airport, from Main St, in 3 min",
        "Line 3 toward Old Town, from Park, in 5 min",
        "Line 1 toward Depot, from Main St, in 6 min",
        "Line 2 toward Zoo, from Main St, in 7 min",
      ]);
    });

    it("caps each row at 10 pills, independently", () => {
      // 12 groups in the top row over two sides, alternating minutes.
      const departuresBySide = streetDepartures();
      departuresBySide.set(S1, Array.from({ length: 6 }, (_, i) => line("r1", `A${i}`, 2 * i + 1)));
      departuresBySide.set(S2, Array.from({ length: 6 }, (_, i) => line("r2", `B${i}`, 2 * i + 2)));
      departuresBySide.set(T3, []);
      const { unmount } = render(<ETACards {...streetProps({ departuresBySide })} />, { wrapper: Wrapper });
      const [top, bottom] = screen.getAllByTestId("eta-row");
      const minutes = within(top).getAllByTestId("eta-countdown").map((c) => c.textContent);
      expect(minutes).toEqual(["1 min", "2 min", "3 min", "4 min", "5 min", "6 min", "7 min", "8 min", "9 min", "10 min"]);
      expect(within(bottom).getAllByTestId("eta-card")).toHaveLength(3);
      unmount();

      // And the other way round: 12 groups in the bottom row, 1 on top.
      const flipped = streetDepartures();
      flipped.set(S2, []);
      flipped.set(T3, []);
      flipped.set(R1, Array.from({ length: 6 }, (_, i) => line("r1", `C${i}`, 2 * i + 1)));
      flipped.set(RR2, Array.from({ length: 6 }, (_, i) => line("r2", `D${i}`, 2 * i + 2)));
      flipped.set(X3, []);
      render(<ETACards {...streetProps({ departuresBySide: flipped })} />, { wrapper: Wrapper });
      const [top2, bottom2] = screen.getAllByTestId("eta-row");
      expect(within(top2).getAllByTestId("eta-card")).toHaveLength(1);
      expect(within(bottom2).getAllByTestId("eta-countdown").map((c) => c.textContent))
        .toEqual(["1 min", "2 min", "3 min", "4 min", "5 min", "6 min", "7 min", "8 min", "9 min", "10 min"]);
    });

    it("a group whose first run has left shows its next run, and switches when it leaves", () => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
      try {
        const departuresBySide = new Map<Side, Departure[]>([
          [S1, [
            // Tiles return runs back to ten minutes ago: the first one is gone.
            makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Airport", tripId: "gone", scheduledTime: new Date(Date.now() - 5 * 60_000).toISOString() }),
            line("r1", "Airport", 1, "next"),
            line("r1", "Airport", 9, "after"),
          ]],
        ]);
        render(<ETACards {...streetProps({ sides: [S1], departuresBySide })} />, { wrapper: Wrapper });
        const label = () => screen.getByTestId("eta-card").getAttribute("aria-label");
        expect(screen.getAllByTestId("eta-card")).toHaveLength(1);
        expect(label()).toBe("Line 1 toward Airport, from Main St, in 1 min");

        // Three minutes on, "next" is past the cutoff too: "after" takes over.
        act(() => { vi.advanceTimersByTime(3 * 60_000); });
        expect(screen.getAllByTestId("eta-card")).toHaveLength(1);
        expect(label()).toBe("Line 1 toward Airport, from Main St, in 6 min");
      } finally {
        vi.useRealTimers();
      }
    });

    it("orders a row by the live (predicted) time, across its sides", () => {
      const departuresBySide = streetDepartures();
      // Line 2 is scheduled at 7 min but predicted at 1 min: it leads the row.
      departuresBySide.set(S2, [{ ...line("r2", "Zoo", 7), predictedTime: inMin(1), delaySeconds: -360 }]);
      render(<ETACards {...streetProps({ departuresBySide })} />, { wrapper: Wrapper });
      const top = screen.getAllByTestId("eta-row")[0];
      expect(pillLines(top)).toEqual(["2", "1", "3"]);
      expect(within(top).getAllByTestId("eta-countdown")[0].textContent).toBe("1 min");
    });

    it("falls back to the nearest stop itself when stopInfo lacks it, with no distance in the header", () => {
      const info = new Map(INFO);
      info.delete("S");
      render(<ETACards {...streetProps({ stopInfo: info })} />, { wrapper: Wrapper });
      const [top] = screen.getAllByTestId("eta-row");
      expect(pillLines(top)).toEqual(["1", "3", "2"]);
      expect(screen.getAllByTestId("eta-row-header").map((h) => h.textContent))
        .toEqual(["Main St", "Opposite direction · Main St · 25 m"]);
    });

    it("filters cancelled departures before grouping and ordering the row", () => {
      const departuresBySide = streetDepartures();
      departuresBySide.set(S1, [
        makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Airport", tripId: "x", cancelled: true, scheduledTime: inMin(1) }),
        line("r1", "Airport", 8),
      ]);
      render(<ETACards {...streetProps({ departuresBySide })} />, { wrapper: Wrapper });
      const top = screen.getAllByTestId("eta-row")[0];
      // Line 1's next active trip is at 8 min: it sorts after 3 (5) and 2 (7).
      expect(pillLines(top)).toEqual(["3", "2", "1"]);
      expect(within(top).getAllByTestId("eta-countdown")[2].textContent).toBe("8 min");
    });

    it("drops departed pills at POPUP_DEPARTED_CUTOFF_MINUTES without spending a slot", () => {
      const departuresBySide = streetDepartures();
      departuresBySide.set(S1, [
        makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Gone", tripId: "gone", scheduledTime: new Date(Date.now() - 121_000).toISOString() }),
        makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Just left", tripId: "left", scheduledTime: new Date(Date.now() - 61_000).toISOString() }),
        ...Array.from({ length: 10 }, (_, i) => line("r1", `A${i}`, i + 10)),
      ]);
      departuresBySide.set(S2, []);
      departuresBySide.set(T3, []);
      render(<ETACards {...streetProps({ departuresBySide })} />, { wrapper: Wrapper });
      const top = screen.getAllByTestId("eta-row")[0];
      const labels = within(top).getAllByTestId("eta-card").map((p) => p.getAttribute("aria-label"));
      expect(labels).toHaveLength(10);
      expect(labels[0]).toBe("Line 1 toward Just left, from Main St, due now");
      expect(labels.some((l) => l?.includes("Gone"))).toBe(false);
    });

    it("no bottom sides → exactly today's single row, with no header", () => {
      const sides = [S1, S2];
      const departuresBySide = new Map<Side, Departure[]>([
        [S1, [line("r1", "Airport", 3)]],
        [S2, [line("r2", "Zoo", 7)]],
      ]);
      render(<ETACards {...streetProps({ sides, departuresBySide })} />, { wrapper: Wrapper });
      expect(screen.getAllByTestId("eta-row")).toHaveLength(1);
      expect(screen.queryByTestId("eta-row-header")).toBeNull();
      expect(screen.queryByRole("group")).toBeNull();
      expect(screen.getAllByTestId("eta-card")).toHaveLength(2);
      expect(screen.queryByTestId("eta-pill-stop")).toBeNull();
    });

    it("renders the nearest stop's row while the opposite row is still loading", () => {
      const pending = new Map<Side, Departure[]>([
        [S1, [line("r1", "Airport", 3)]],
        [S2, [line("r2", "Zoo", 7)]],
        [R1, []],
        [RR2, []],
        [X3, []],
        [T3, []],
      ]);
      const { rerender } = render(<ETACards {...streetProps({ departuresBySide: pending })} />, { wrapper: Wrapper });
      expect(screen.getAllByTestId("eta-row")).toHaveLength(1);
      expect(screen.queryByTestId("eta-row-header")).toBeNull();
      expect(screen.getAllByTestId("eta-card")).toHaveLength(2);

      rerender(<ETACards {...streetProps()} />);
      expect(screen.getAllByTestId("eta-row")).toHaveLength(2);
      expect(screen.getAllByTestId("eta-row-header")).toHaveLength(2);
    });

    it("an opposite row alone keeps its header", () => {
      const departuresBySide = new Map<Side, Departure[]>([
        [S1, []],
        [S2, []],
        [R1, [line("r1", "Centre", 4)]],
        [RR2, []],
        [X3, []],
        [T3, []],
      ]);
      render(<ETACards {...streetProps({ departuresBySide })} />, { wrapper: Wrapper });
      expect(screen.getAllByTestId("eta-row")).toHaveLength(1);
      expect(screen.getAllByTestId("eta-row-header").map((h) => h.textContent))
        .toEqual(["Opposite direction · Main St · 25 m"]);
    });

    it("renders nothing while the nearest stop is loading", () => {
      const { container } = render(<ETACards {...streetProps({ loading: true })} />, { wrapper: Wrapper });
      expect(container.querySelector("[data-testid='eta-cards']")).toBeNull();
    });

    it("skips a side whose stop is unknown", () => {
      const info = new Map(INFO);
      info.delete("T");
      render(<ETACards {...streetProps({ stopInfo: info })} />, { wrapper: Wrapper });
      const top = screen.getAllByTestId("eta-row")[0];
      expect(pillLines(top)).toEqual(["1", "2"]);
    });

    it("builds the opposite header from the eta.row_opposite translation", () => {
      const translations: Record<string, string> = {
        "eta.row_opposite": "Other side",
        "unit.meters": "{n} metres",
      };
      const t = (key: string, fallback?: string) => translations[key] ?? fallback ?? key;
      render(
        <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t }}>
          <ETACards {...streetProps()} />
        </I18nContext.Provider>,
      );
      expect(screen.getAllByTestId("eta-row-header").map((h) => h.textContent))
        .toEqual(["Main St · 12 metres", "Other side · Main St · 25 metres"]);
    });
  });

  describe("columns layout", () => {
    function columnsProps(overrides: Partial<Props> = {}): Props {
      return streetProps({ layout: "columns", ...overrides });
    }

    /** `[route, row]` of every grid cell, in DOM order. */
    const cells = () =>
      screen.getAllByTestId("eta-cell").map((c) => [c.getAttribute("data-route"), c.getAttribute("data-row")]);

    const cellOf = (route: string, row: string) =>
      screen.getAllByTestId("eta-cell")
        .find((c) => c.getAttribute("data-route") === route && c.getAttribute("data-row") === row)!;

    it("renders one column per route, both rows in one horizontal scroller", () => {
      render(<ETACards {...columnsProps()} />, { wrapper: Wrapper });
      expect(screen.queryByTestId("eta-row")).toBeNull();
      const grid = screen.getByTestId("eta-columns");
      expect(grid.className).toMatch(/\boverflow-x-auto\b/);
      // Every pill, top and bottom, scrolls with the one grid.
      expect(within(grid).getAllByTestId("eta-card")).toHaveLength(6);
      expect(screen.getAllByTestId("eta-card")).toHaveLength(6);
      const routes = within(grid).getAllByTestId("eta-cell").map((c) => c.getAttribute("data-route"));
      expect(routes).toHaveLength(6);
      expect(new Set(routes)).toEqual(new Set(["r1", "r2", "r3"]));
    });

    it("orders columns by the soonest departure of either cell, each column top then bottom", () => {
      render(<ETACards {...columnsProps()} />, { wrapper: Wrapper });
      // Line 2: 2 min at R; line 1: 3 min at S; line 3: 5 min at T.
      expect(cells()).toEqual([
        ["r2", "top"], ["r2", "bottom"],
        ["r1", "top"], ["r1", "bottom"],
        ["r3", "top"], ["r3", "bottom"],
      ]);
      const grid = screen.getByTestId("eta-columns");
      expect(within(grid).getAllByTestId("eta-countdown").map((c) => c.textContent))
        .toEqual(["7 min", "2 min", "3 min", "4 min", "5 min", "9 min"]);
    });

    it("fills a cell with the route's soonest visible departure in that row, over any headsign and side", () => {
      // Line 1 also leaves S the other way (a terminus): a second top side.
      const loop: Side = { stopId: "S", routeId: "r1", dirKey: "h:Loop", row: "top" };
      const departuresBySide = streetDepartures();
      departuresBySide.set(S1, [
        makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Gone", tripId: "gone", scheduledTime: new Date(Date.now() - 121_000).toISOString() }),
        makeDeparture({ routeId: "r1", routeShortName: "1", headsign: "Airport", tripId: "x", cancelled: true, scheduledTime: inMin(1) }),
        line("r1", "Airport", 8),
        line("r1", "Depot", 6),
      ]);
      departuresBySide.set(loop, [line("r1", "Loop", 5)]);
      render(
        <ETACards {...columnsProps({ sides: [...SIDES, loop], departuresBySide })} />,
        { wrapper: Wrapper },
      );
      expect(within(cellOf("r1", "top")).getByTestId("eta-card").getAttribute("aria-label"))
        .toBe("Line 1 toward Loop, from Main St, in 5 min");
      expect(within(cellOf("r1", "bottom")).getByTestId("eta-card").getAttribute("aria-label"))
        .toBe("Line 1 toward Centre, from Main St, in 4 min");
      // One column per route, whatever its headsigns and sides.
      expect(screen.getAllByTestId("eta-cell")).toHaveLength(6);
    });

    it("leaves the other cell empty for a route with one side, keeping the columns aligned", () => {
      const lake: Side = { stopId: "S", routeId: "r4", dirKey: "d0", row: "top" };
      const departuresBySide = streetDepartures();
      departuresBySide.set(lake, [line("r4", "Lake", 1)]);
      render(
        <ETACards {...columnsProps({ sides: [...SIDES, lake], departuresBySide })} />,
        { wrapper: Wrapper },
      );
      expect(cells()).toEqual([
        ["r4", "top"], ["r4", "bottom"],
        ["r2", "top"], ["r2", "bottom"],
        ["r1", "top"], ["r1", "bottom"],
        ["r3", "top"], ["r3", "bottom"],
      ]);
      const empty = cellOf("r4", "bottom");
      expect(within(empty).queryByTestId("eta-card")).toBeNull();
      expect(empty.getAttribute("aria-hidden")).toBe("true");
      expect(within(cellOf("r4", "top")).getByTestId("eta-card")).toBeTruthy();
      expect(screen.getAllByTestId("eta-card")).toHaveLength(7);
    });

    it("empties a departed cell and removes a column whose cells have both departed", () => {
      const gone = (routeId: string, headsign: string) => makeDeparture({
        routeId, routeShortName: routeId.slice(1), headsign, tripId: `${routeId}-gone`,
        scheduledTime: new Date(Date.now() - 121_000).toISOString(),
      });
      const departuresBySide = streetDepartures();
      departuresBySide.set(S1, [gone("r1", "Airport")]);
      departuresBySide.set(R1, [gone("r1", "Centre")]);
      departuresBySide.set(RR2, [gone("r2", "Harbour")]);
      render(<ETACards {...columnsProps({ departuresBySide })} />, { wrapper: Wrapper });
      // Line 1 is gone both ways; line 2's bottom cell is empty.
      expect(cells()).toEqual([
        ["r3", "top"], ["r3", "bottom"],
        ["r2", "top"], ["r2", "bottom"],
      ]);
      expect(within(cellOf("r2", "bottom")).queryByTestId("eta-card")).toBeNull();
      expect(within(cellOf("r2", "top")).getByTestId("eta-countdown").textContent).toBe("7 min");
    });

    it("carries both row labels in a sticky first column", () => {
      render(<ETACards {...columnsProps()} />, { wrapper: Wrapper });
      const grid = screen.getByTestId("eta-columns");
      const labels = within(grid).getAllByTestId("eta-column-label");
      expect(labels.map((l) => l.textContent)).toEqual(["Main St · 12 m", "Opposite direction · Main St · 25 m"]);
      // The first grid column: before every cell, pinned to the scroller's left edge.
      expect(grid.children[0]).toBe(labels[0]);
      expect(grid.children[1]).toBe(labels[1]);
      for (const label of labels) {
        expect(label.className).toMatch(/\bsticky\b/);
        expect(label.className).toMatch(/\bleft-0\b/);
      }
      expect(screen.queryByTestId("eta-row-header")).toBeNull();
    });

    it("describes each pill by its row's label", () => {
      render(<ETACards {...columnsProps()} />, { wrapper: Wrapper });
      const [topLabel, bottomLabel] = screen.getAllByTestId("eta-column-label");
      expect(topLabel.id).not.toBe("");
      expect(bottomLabel.id).not.toBe("");
      for (const cell of screen.getAllByTestId("eta-cell")) {
        const label = cell.getAttribute("data-row") === "top" ? topLabel : bottomLabel;
        expect(within(cell).getByTestId("eta-card").getAttribute("aria-describedby")).toBe(label.id);
      }
    });

    it("names a pill's stop when it differs from its row's main stop, and selects with it", () => {
      const onSelect = vi.fn();
      const departuresBySide = streetDepartures();
      const [extra] = departuresBySide.get(X3)!;
      render(<ETACards {...columnsProps({ departuresBySide, onSelect })} />, { wrapper: Wrapper });
      expect(within(cellOf("r3", "top")).getByTestId("eta-pill-stop").textContent).toBe("Park");
      expect(within(cellOf("r3", "bottom")).getByTestId("eta-pill-stop").textContent).toBe("Side St");
      expect(within(cellOf("r1", "top")).queryByTestId("eta-pill-stop")).toBeNull();
      expect(within(cellOf("r1", "bottom")).queryByTestId("eta-pill-stop")).toBeNull();

      fireEvent.click(within(cellOf("r3", "bottom")).getByTestId("eta-card"));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls[0][0]).toBe(extra);
      expect(onSelect.mock.calls[0][1]).toBe(R2);
    });

    it("caps the grid at 10 columns, soonest first", () => {
      const sides: Side[] = [];
      const departuresBySide = new Map<Side, Departure[]>();
      for (let i = 0; i < 12; i++) {
        const top: Side = { stopId: "S", routeId: `q${i}`, dirKey: "d0", row: "top" };
        const bottom: Side = { stopId: "R", routeId: `q${i}`, dirKey: "d1", row: "bottom" };
        sides.push(top, bottom);
        // Listed latest first: the order comes from the times.
        departuresBySide.set(top, [line(`q${i}`, "Out", 25 - 2 * i)]);
        departuresBySide.set(bottom, [line(`q${i}`, "Back", 26 - 2 * i)]);
      }
      render(<ETACards {...columnsProps({ sides, departuresBySide })} />, { wrapper: Wrapper });
      const routes = cells().filter(([, row]) => row === "top").map(([route]) => route);
      expect(routes).toEqual(["q11", "q10", "q9", "q8", "q7", "q6", "q5", "q4", "q3", "q2"]);
      expect(screen.getAllByTestId("eta-card")).toHaveLength(20);
    });

    it("with no bottom row to show, renders the single row without headers", () => {
      const departuresBySide = new Map<Side, Departure[]>([
        [S1, [line("r1", "Airport", 3)]],
        [S2, [line("r2", "Zoo", 7)]],
      ]);
      render(
        <ETACards {...columnsProps({ sides: [S1, S2], departuresBySide })} />,
        { wrapper: Wrapper },
      );
      expect(screen.queryByTestId("eta-columns")).toBeNull();
      expect(screen.getAllByTestId("eta-row")).toHaveLength(1);
      expect(screen.queryByTestId("eta-row-header")).toBeNull();
      expect(screen.getAllByTestId("eta-card")).toHaveLength(2);
    });

    it("with only the bottom row to show, renders it as the headed opposite row", () => {
      const departuresBySide = new Map<Side, Departure[]>([
        [S1, []],
        [S2, []],
        [R1, [line("r1", "Centre", 4)]],
        [RR2, []],
        [X3, []],
        [T3, []],
      ]);
      render(<ETACards {...columnsProps({ departuresBySide })} />, { wrapper: Wrapper });
      expect(screen.queryByTestId("eta-columns")).toBeNull();
      expect(screen.getAllByTestId("eta-row")).toHaveLength(1);
      expect(screen.getAllByTestId("eta-row-header").map((h) => h.textContent))
        .toEqual(["Opposite direction · Main St · 25 m"]);
    });

    it("renders nothing while the nearest stop is loading", () => {
      const { container } = render(<ETACards {...columnsProps({ loading: true })} />, { wrapper: Wrapper });
      expect(container.querySelector("[data-testid='eta-cards']")).toBeNull();
    });
  });
});
