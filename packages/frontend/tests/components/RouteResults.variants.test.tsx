import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import { RouteResults } from "../../src/components/RouteResults/RouteResults.tsx";
import { RouteResultsPower } from "../../src/components/RouteResults/RouteResultsPower.tsx";
import { RouteResultsAccessible } from "../../src/components/RouteResults/RouteResultsAccessible.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { polledRoutes } from "../helpers/rtPollerRoutes.ts";
import {
  useSettingsStore,
  type RouteSearchVariant,
} from "../../src/stores/settingsStore.ts";
import type { Itinerary, Leg } from "@pt/shared";
import {
  ms,
  place,
  ride,
  walk,
  itinerary as buildItinerary,
} from "./shared-fixtures.ts";

/**
 * Smoke tests that render the RouteResults dispatcher with each of the three
 * variants. These catch "broken import in non-default variant" regressions
 * that the main RouteResults.test.tsx suite can't detect — its tests all
 * implicitly exercise the `consumer` default only.
 *
 * Keep assertions minimal: a broken render throws before anything renders,
 * and that's what we want to catch. Behavioral contracts live in the main
 * suite (which runs against `consumer`) and can be re-parametrized later
 * if variant-specific divergence grows.
 */

function itinerary(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    legs: [
      {
        mode: "BUS",
        from: { name: "A", location: { lat: 0, lon: 0 } },
        to: { name: "B", location: { lat: 0, lon: 0 } },
        departureTime: "2026-03-03T10:00:00Z",
        arrivalTime: "2026-03-03T10:15:00Z",
        durationSeconds: 900,
        routeShortName: "42",
      },
    ],
    departureTime: "2026-03-03T10:00:00Z",
    arrivalTime: "2026-03-03T10:15:00Z",
    durationSeconds: 900,
    transfers: 0,
    walkingDistanceMeters: 200,
    ...overrides,
  };
}

describe("RouteResults — variant dispatch", () => {
  beforeEach(() => {
    useSettingsStore.setState({ routeSearchVariant: "consumer" });
  });

  for (const variant of ["consumer", "power", "accessible"] as RouteSearchVariant[]) {
    it(`renders an itinerary without crashing in variant=${variant}`, () => {
      useSettingsStore.setState({ routeSearchVariant: variant });
      render(
        <BrowserRouter>
          <RouteResults itineraries={[itinerary()]} onSelect={() => {}} />
        </BrowserRouter>,
      );
      // route-badge is emitted by every variant's leg chip renderer
      expect(screen.getAllByTestId("route-badge").length).toBeGreaterThan(0);
      // "42" label appears in every variant
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    it(`renders the departure time in variant=${variant}`, () => {
      useSettingsStore.setState({ routeSearchVariant: variant });
      const { container } = render(
        <BrowserRouter>
          <RouteResults itineraries={[itinerary()]} onSelect={() => {}} />
        </BrowserRouter>,
      );
      // Both HH:mm timestamps should appear somewhere (may be localized)
      const text = container.textContent ?? "";
      // Match \d{1,2}:\d{2} — en-US renders "10:00 AM", others 24h.
      expect(text).toMatch(/\d{1,2}:\d{2}/);
    });

    it(`renders itinerary-card testid in variant=${variant}`, () => {
      useSettingsStore.setState({ routeSearchVariant: variant });
      render(
        <BrowserRouter>
          <RouteResults itineraries={[itinerary()]} onSelect={() => {}} />
        </BrowserRouter>,
      );
      // Every variant must render at least one itinerary-card for e2e regression guard
      const cards = screen.getAllByTestId("itinerary-card");
      expect(cards.length).toBeGreaterThan(0);
    });
  }
});

describe("RouteResultsPower — buffer + leading-wait tokens", () => {
  it("renders leading-wait token in LegStrip when leadingWait > 0", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = buildItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { getByText } = render(
      <I18nProvider>
        <RouteResultsPower
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T10:00:00Z")}
          bufferSeconds={180}
        />
      </I18nProvider>,
    );
    // 22 min leading wait (10:30 − 3 min buffer − 5 min walk = leave 10:22) +
    // leave time (locale-formatted, so we just test for "22m · leave")
    expect(getByText(/22m · leave/i)).toBeInTheDocument();
  });

  it("tells the rider to hurry when only a run makes the first departure", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = buildItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:05:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    const { getByText } = render(
      <I18nProvider>
        <RouteResultsPower
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T10:02:00Z")}
          bufferSeconds={180}
          runSpeedRatio={2}
        />
      </I18nProvider>,
    );
    expect(getByText(/walk fast or run to make it/i)).toBeInTheDocument();
  });

  it("shows a cancelled trip's warning, as the consumer layout does", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = {
      ...buildItinerary([
        walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
        ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
      ]),
      cancelled: true,
    };
    for (const Variant of [RouteResultsPower, RouteResultsAccessible]) {
      const { getByText, unmount } = render(
        <I18nProvider>
          <Variant itineraries={[it]} onSelect={() => {}} referenceNowMs={ms("2026-04-25T10:00:00Z")} bufferSeconds={180} />
        </I18nProvider>,
      );
      expect(getByText("Trip is cancelled")).toBeInTheDocument();
      unmount();
    }
  });

  it("does NOT render banner regardless of leading wait (Power has no banner slot)", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = buildItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { queryByText } = render(
      <I18nProvider>
        <RouteResultsPower
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T09:00:00Z")}
          bufferSeconds={180}
        />
      </I18nProvider>,
    );
    expect(queryByText(/Next departure in/i)).toBeNull();
  });

  it("does NOT render leading-wait token when leadingWait === 0 (e.g., bus is now)", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = buildItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { queryByText } = render(
      <I18nProvider>
        <RouteResultsPower
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T10:30:00Z")} // referenceNow at firstTransitDep → alreadyDeparted, no token
          bufferSeconds={180}
        />
      </I18nProvider>,
    );
    expect(queryByText(/leave/i)).toBeNull();
  });
});

describe("RouteResultsAccessible — buffer + transfer-wait rows", () => {
  it("prepends AccessibleWaitRow for buffer when bufferSeconds > 0", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = buildItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { getByText } = render(
      <I18nProvider>
        <RouteResultsAccessible
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T10:00:00Z")}
          bufferSeconds={180}
        />
      </I18nProvider>,
    );
    expect(getByText(/Wait 3 min at Stop A/i)).toBeInTheDocument();
  });

  it("renders AccessibleWaitRow between two ride rows for transfer waits", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Stop B"), D = place("Office");
    const it = buildItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:40:00Z", routeShortName: "42" }),
      ride({ from: C, to: D, depart: "2026-04-25T10:46:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "7" }),
    ]);
    const { getByText } = render(
      <I18nProvider>
        <RouteResultsAccessible
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T10:00:00Z")}
          bufferSeconds={180}
        />
      </I18nProvider>,
    );
    expect(getByText(/Wait 6 min at Stop B/i)).toBeInTheDocument();
  });

  it("does NOT render banner regardless of leading wait", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = buildItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { queryByText } = render(
      <I18nProvider>
        <RouteResultsAccessible
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T09:00:00Z")}
          bufferSeconds={180}
        />
      </I18nProvider>,
    );
    expect(queryByText(/Next departure in/i)).toBeNull();
  });

  it("suppresses all wait rows when parseFailed", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const badRide: Leg = {
      mode: "BUS", from: B, to: C, departureTime: "not-a-date",
      arrivalTime: "2026-04-25T10:54:00Z", durationSeconds: 1440, routeShortName: "42",
    };
    const it: Itinerary = {
      legs: [walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }), badRide],
      departureTime: "2026-04-25T10:25:00Z",
      arrivalTime: "2026-04-25T10:54:00Z",
      durationSeconds: 1740,
      transfers: 0,
      walkingDistanceMeters: 0,
    };
    const { queryByText } = render(
      <I18nProvider>
        <RouteResultsAccessible
          itineraries={[it]}
          onSelect={() => {}}
          referenceNowMs={ms("2026-04-25T10:00:00Z")}
          bufferSeconds={180}
        />
      </I18nProvider>,
    );
    // Buffer wait suppressed; transfer waits don't apply (single ride). Confirm no Wait rows.
    expect(queryByText(/Wait \d+ min at/i)).toBeNull();
  });
});

describe("RouteResults — run-to-catch setting reaches the cards", () => {
  beforeEach(() => {
    // RouteResults anchors "now" on serverTime.now(), which is Date.now() pre-sync.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T10:02:00Z"));
    useSettingsStore.setState({
      routeSearchVariant: "consumer",
      mobilityProfile: "default",
      walkSpeedMps: 1.25,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    useSettingsStore.setState({ runToCatch: false } as never);
  });

  // 10:02: a 4-min walk lands 10:06, after the 10:05 bus; a 2-min run makes it.
  const late = () =>
    buildItinerary([
      walk({ from: place("Home"), to: place("Stop A"), depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: place("Stop A"), to: place("Office"), depart: "2026-04-25T10:05:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);

  it("says hurry with run-to-catch on", () => {
    useSettingsStore.setState({ runToCatch: true } as never);
    render(
      <BrowserRouter>
        <RouteResults itineraries={[late()]} onSelect={() => {}} />
      </BrowserRouter>,
    );
    expect(screen.getByText(/walk fast or run to make it/i)).toBeInTheDocument();
  });

  it("says likely miss with run-to-catch off", () => {
    useSettingsStore.setState({ runToCatch: false } as never);
    render(
      <BrowserRouter>
        <RouteResults itineraries={[late()]} onSelect={() => {}} />
      </BrowserRouter>,
    );
    expect(screen.getByText(/likely miss this departure/i)).toBeInTheDocument();
  });
});

describe("RouteResults — the cards follow the clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T10:00:00Z"));
    useSettingsStore.setState({
      routeSearchVariant: "consumer",
      mobilityProfile: "default",
      runToCatch: false,
      leaveBufferOverrideSeconds: null,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a leave time into a miss as the minutes pass, without a new search", () => {
    // 4-min walk to a 10:10 bus: leave 10:03. By 10:07 walking no longer makes it.
    const trip = buildItinerary([
      walk({ from: place("Home"), to: place("Stop A"), depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: place("Stop A"), to: place("Office"), depart: "2026-04-25T10:10:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    render(
      <BrowserRouter>
        <RouteResults itineraries={[trip]} onSelect={() => {}} />
      </BrowserRouter>,
    );
    expect(screen.getByText(/3 min wait at stop/i)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(7 * 60_000);
    });
    expect(screen.getByText(/likely miss this departure/i)).toBeInTheDocument();
  });
});

describe("RouteResults — live data for the first rides", () => {
  const polled = polledRoutes;

  beforeEach(() => {
    vi.spyOn(useRtStore.getState().poller, "start").mockImplementation(() => {});
    useRtStore.getState().unsubscribeAll();
    useSettingsStore.setState({ routeSearchVariant: "consumer" } as never);
  });

  afterEach(() => {
    useRtStore.getState().unsubscribeAll();
    vi.restoreAllMocks();
  });

  it("polls each result's first ride while the list is open, and lets go after", () => {
    const withRoute = (routeId: string) =>
      itinerary({ legs: [{ ...itinerary().legs[0], tripId: `t-${routeId}`, routeId }] });
    const { unmount } = render(
      <BrowserRouter>
        <RouteResults itineraries={[withRoute("r1"), withRoute("r2"), withRoute("r1")]} onSelect={() => {}} />
      </BrowserRouter>,
    );
    expect(polled()).toEqual(["r1", "r2"]);
    unmount();
    expect(polled()).toEqual([]);
  });
});
