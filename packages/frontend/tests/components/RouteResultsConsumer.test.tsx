import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Itinerary, Leg } from "@pt/shared";
import { BrowserRouter } from "react-router-dom";
import { RouteResultsConsumer } from "../../src/components/RouteResults/RouteResultsConsumer.tsx";
import { I18nProvider } from "../../src/i18n/I18nProvider.tsx";
import { ms, place, ride, walk, itinerary } from "./shared-fixtures.ts";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { lineThreeIndex } from "../helpers/lineThreeIndex.ts";

/**
 * Behavioural coverage for the Consumer card variant. The variants smoke
 * test (`RouteResults.variants.test.tsx`) only checks "renders without
 * crashing"; this file locks the actual UX rules from the spec:
 *
 *   - LeaveHint shows when there's a buffer
 *   - LeadingWaitBanner shows above threshold
 *   - Banner is suppressed by miss-risk and live-delay (priority cascade)
 *   - When banner is suppressed, the inline hint still renders
 *   - Transfer-wait chips appear between two ride chips, but tight waits
 *     are suppressed (already styled by the bar + miss-risk callout)
 *   - parseFailed and alreadyDeparted hide all buffer chrome
 */

function renderWithProviders(node: React.ReactNode) {
  return render(
    <BrowserRouter>
      <I18nProvider>{node}</I18nProvider>
    </BrowserRouter>,
  );
}

describe("RouteResultsConsumer — LeaveHint", () => {
  it("renders LeaveHint when bufferSeconds > 0 and there's a leading wait", () => {
    const A = place("Home"),
      B = place("Stop A"),
      C = place("Office");
    const it = itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { getByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    expect(getByText(/min wait at stop/i)).toBeInTheDocument();
  });

  it("does NOT render LeaveHint when bufferSeconds === 0 (caller disabled)", () => {
    const A = place("Home"),
      B = place("Stop A"),
      C = place("Office");
    const it = itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { queryByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={0}
      />,
    );
    expect(queryByText(/min wait at stop/i)).toBeNull();
  });
});

describe("RouteResultsConsumer — LeadingWaitBanner threshold", () => {
  function setupLongLeadingWait() {
    const A = place("Home"),
      B = place("Stop A"),
      C = place("Office");
    return itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
  }

  it("renders banner when leadingWait > 5 min (default profile, buffer 180s)", () => {
    const it = setupLongLeadingWait();
    // referenceNow at 10:00, ride at 10:30, buffer 3min → recommendedDeparture 10:27 → leadingWait 27min
    const { getByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    expect(getByText(/Next departure in/i)).toBeInTheDocument();
  });

  it("does NOT render banner when leadingWait <= 5 min", () => {
    const it = setupLongLeadingWait();
    // referenceNow at 10:25, ride at 10:30, buffer 180s → leadingWait 2min (below 5-min floor)
    const { queryByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:25:00Z")}
        bufferSeconds={180}
      />,
    );
    expect(queryByText(/Next departure in/i)).toBeNull();
  });
});

describe("RouteResultsConsumer — banner suppression by higher-priority callouts", () => {
  it("suppresses banner on miss-risk; LeaveHint still renders (priority: miss > leading-wait)", () => {
    // Tight transfer (2 min wait, < TIGHT_WAIT_MIN of 3) with first ride
    // delayed enough to consume it — produces transferRisk === "miss".
    // referenceNow far enough back to also make leadingWait > banner threshold.
    const A = place("Home"),
      S1 = place("Stop A", 0, 0, "S1"),
      S2 = place("Stop B", 0, 0, "S2"),
      D = place("Dest");
    const it = itinerary([
      walk({ from: A, to: S1, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({
        from: S1,
        to: S2,
        depart: "2026-04-25T10:30:00Z",
        arrive: "2026-04-25T10:40:00Z",
        routeShortName: "42",
        delaySeconds: 180, // 3 min late, will consume the 2-min tight wait → miss
      }),
      ride({
        from: S2,
        to: D,
        depart: "2026-04-25T10:42:00Z",
        arrive: "2026-04-25T10:54:00Z",
        routeShortName: "7",
      }),
    ]);
    const { queryByText, getByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    // Banner suppressed by miss-risk
    expect(queryByText(/Next departure in/i)).toBeNull();
    // Inline hint still renders
    expect(getByText(/min wait at stop/i)).toBeInTheDocument();
  });

  it("suppresses banner on live-delay (>= 2 min); LeaveHint still renders (priority: delay > leading-wait)", () => {
    const A = place("Home"),
      B = place("Stop A"),
      C = place("Office");
    const it = itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({
        from: B,
        to: C,
        depart: "2026-04-25T10:30:00Z",
        arrive: "2026-04-25T10:54:00Z",
        routeShortName: "42",
        delaySeconds: 180, // 3 min delay → liveDelay.minutes = 3 ≥ 2
      }),
    ]);
    const { queryByText, getByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    expect(queryByText(/Next departure in/i)).toBeNull();
    expect(getByText(/min wait at stop/i)).toBeInTheDocument();
  });
});

describe("RouteResultsConsumer — transfer-wait chip", () => {
  it("renders chip between two ride chips for non-tight transfer waits", () => {
    const A = place("Home"),
      S1 = place("Stop A"),
      S2 = place("Stop B"),
      D = place("Dest");
    const it = itinerary([
      walk({ from: A, to: S1, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: S1, to: S2, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:40:00Z", routeShortName: "42" }),
      ride({ from: S2, to: D, depart: "2026-04-25T10:45:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "7" }),
    ]);
    const { getByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    // 5-min wait at stop B between rides 42 and 7 → not tight → chip renders
    expect(getByText(/5m wait/i)).toBeInTheDocument();
  });

  it("does NOT render chip for tight transfer waits (already flagged by miss-risk callout)", () => {
    const A = place("Home"),
      S1 = place("Stop A"),
      S2 = place("Stop B"),
      D = place("Dest");
    const it = itinerary([
      walk({ from: A, to: S1, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: S1, to: S2, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:40:00Z", routeShortName: "42" }),
      ride({ from: S2, to: D, depart: "2026-04-25T10:42:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "7" }),
    ]);
    const { queryByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    // 2-min tight wait at S2 → no chip (the bar segment + miss-risk callout carry it)
    expect(queryByText(/2m wait/i)).toBeNull();
  });

  it("does NOT render a chip for buffer-wait segments", () => {
    const A = place("Home"),
      B = place("Stop A"),
      C = place("Office");
    const it = itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { queryByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    // Buffer wait is communicated via LeaveHint + bar segment, not via a chip
    // (chip would triple-announce). 3m wait at stop A would be visible if a
    // chip were emitted; assert it's not.
    expect(queryByText(/3m wait/i)).toBeNull();
  });
});

describe("RouteResultsConsumer — parseFailed and alreadyDeparted hide buffer chrome", () => {
  it("hides LeaveHint and banner when first transit leg has malformed ISO (parseFailed)", () => {
    const A = place("Home"),
      B = place("Stop A"),
      C = place("Office");
    const badRide: Leg = {
      mode: "BUS",
      from: B,
      to: C,
      departureTime: "not-a-date",
      arrivalTime: "2026-04-25T10:54:00Z",
      durationSeconds: 1440,
      routeShortName: "42",
    };
    const it: Itinerary = {
      legs: [
        walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
        badRide,
      ],
      departureTime: "2026-04-25T10:25:00Z",
      arrivalTime: "2026-04-25T10:54:00Z",
      durationSeconds: 1740,
      transfers: 0,
      walkingDistanceMeters: 0,
    };
    const { queryByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:00:00Z")}
        bufferSeconds={180}
      />,
    );
    expect(queryByText(/min wait at stop/i)).toBeNull();
    expect(queryByText(/Next departure in/i)).toBeNull();
  });

  it("hides LeaveHint and banner when first transit leg has already departed", () => {
    const A = place("Home"),
      B = place("Stop A"),
      C = place("Office");
    const it = itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    const { queryByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        // referenceNow AFTER the first transit dep
        referenceNowMs={ms("2026-04-25T10:35:00Z")}
        bufferSeconds={180}
      />,
    );
    expect(queryByText(/min wait at stop/i)).toBeNull();
    expect(queryByText(/Next departure in/i)).toBeNull();
  });
});

describe("RouteResultsConsumer — catch status", () => {
  it("tells the rider to hurry when only a run makes the first departure", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = itinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:05:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    const { getByText, queryByText } = renderWithProviders(
      <RouteResultsConsumer
        itineraries={[it]}
        onSelect={() => {}}
        referenceNowMs={ms("2026-04-25T10:02:00Z")}
        bufferSeconds={180}
        runSpeedRatio={2}
      />,
    );
    expect(getByText(/walk fast or run to make it/i)).toBeInTheDocument();
    expect(queryByText(/min wait at stop/i)).toBeNull();
  });
});

describe("RouteResultsConsumer — live RT on the first ride", () => {
  afterEach(() => {
    useRtStore.setState({ updates: new Map() });
  });

  // 10:00, 4-min walk to the 10:10 bus: leave 10:03 on the timetable.
  const trip = () =>
    itinerary([
      walk({ from: place("Home"), to: place("Stop A"), depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      { ...ride({ from: place("Stop A"), to: place("Office"), depart: "2026-04-25T10:10:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }), tripId: "t42", routeId: "r42" },
    ]);

  it("moves the leave time when the bus is running early", () => {
    // 5 min early: 10:05 leaves 1 min at the stop after a 4-min walk.
    useRtStore.setState({ updates: new Map([["r42", [{ tripId: "t42", delaySeconds: -300, cancelled: false }]]]) });
    const { getByText } = renderWithProviders(
      <RouteResultsConsumer itineraries={[trip()]} onSelect={() => {}} referenceNowMs={ms("2026-04-25T10:00:00Z")} bufferSeconds={180} />,
    );
    expect(getByText(/1 min wait at stop/i)).toBeInTheDocument();
  });

  it("shows the live delay on the ride's badge", () => {
    useRtStore.setState({ updates: new Map([["r42", [{ tripId: "t42", delaySeconds: 180, cancelled: false }]]]) });
    const { getByText } = renderWithProviders(
      <RouteResultsConsumer itineraries={[trip()]} onSelect={() => {}} referenceNowMs={ms("2026-04-25T10:00:00Z")} bufferSeconds={180} />,
    );
    expect(getByText(/\+3/)).toBeInTheDocument();
  });
});

describe("RouteResultsConsumer — header", () => {
  it("counts the trip from the leave time: 10:03 → 10:30 is 27 min, not 30", () => {
    const trip = itinerary([
      walk({ from: place("Home"), to: place("Stop A"), depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: place("Stop A"), to: place("Office"), depart: "2026-04-25T10:10:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    const { getByText, queryByText } = renderWithProviders(
      <RouteResultsConsumer itineraries={[trip]} onSelect={() => {}} referenceNowMs={ms("2026-04-25T10:00:00Z")} bufferSeconds={180} />,
    );
    expect(getByText("27 min")).toBeInTheDocument();
    expect(queryByText("30 min")).toBeNull();
  });
});

describe("RouteResultsConsumer — after a likely miss", () => {
  const realCity = useCityStore.getState().activeCity;

  afterEach(() => {
    useCityStore.setState({ activeCity: realCity });
    useGtfsDataStore.setState({ raptorIndex: null });
  });

  it("offers the same line's next departure from the same stop", () => {
    useCityStore.setState({ activeCity: { ...realCity, tz: "UTC" } });
    useGtfsDataStore.setState({ raptorIndex: lineThreeIndex });
    // 07:58, 4-min walk to line 3's 08:00 from S1: missed. The next is 08:10.
    const trip = itinerary([
      walk({ from: place("Home"), to: place("Stop 1", 0, 0, "S1"), depart: "2026-09-25T07:55:00Z", arrive: "2026-09-25T07:59:00Z" }),
      { ...ride({ from: place("Stop 1", 0, 0, "S1"), to: place("Stop 2", 0, 0, "S2"), depart: "2026-09-25T08:00:00Z", arrive: "2026-09-25T08:10:00Z", routeShortName: "3" }), tripId: "T800", routeId: "R3" },
    ]);
    const { getByText } = renderWithProviders(
      <RouteResultsConsumer itineraries={[trip]} onSelect={() => {}} referenceNowMs={ms("2026-09-25T07:58:00Z")} bufferSeconds={180} />,
    );
    expect(getByText("You'll likely miss this departure · next in ~12 min")).toBeInTheDocument();
  });
});

describe("RouteResultsConsumer — the first ride is cancelled live", () => {
  const realCity = useCityStore.getState().activeCity;

  afterEach(() => {
    useCityStore.setState({ activeCity: realCity });
    useGtfsDataStore.setState({ raptorIndex: null });
    useRtStore.setState({ updates: new Map() });
  });

  it("says so, marks the ride, and offers the next bus that runs", () => {
    useCityStore.setState({ activeCity: { ...realCity, tz: "UTC" } });
    useGtfsDataStore.setState({ raptorIndex: lineThreeIndex });
    useRtStore.setState({ updates: new Map([["R3", [{ tripId: "T800", delaySeconds: 0, cancelled: true }]]]) });
    const trip = itinerary([
      walk({ from: place("Home"), to: place("Stop 1", 0, 0, "S1"), depart: "2026-09-25T07:52:00Z", arrive: "2026-09-25T07:56:00Z" }),
      { ...ride({ from: place("Stop 1", 0, 0, "S1"), to: place("Stop 2", 0, 0, "S2"), depart: "2026-09-25T08:00:00Z", arrive: "2026-09-25T08:10:00Z", routeShortName: "3" }), tripId: "T800", routeId: "R3" },
    ]);
    const { getByText, queryByText } = renderWithProviders(
      <RouteResultsConsumer itineraries={[trip]} onSelect={() => {}} referenceNowMs={ms("2026-09-25T07:55:00Z")} bufferSeconds={180} />,
    );
    // 08:00 is cancelled; line 3 next leaves S1 at 08:10.
    expect(getByText("This departure is cancelled · next in ~15 min")).toBeInTheDocument();
    expect(getByText("Cancelled")).toBeInTheDocument();
    expect(queryByText(/min wait at stop/i)).toBeNull();
  });
});

describe("RouteResultsConsumer — the first ride is removed live (DELETED)", () => {
  const realCity = useCityStore.getState().activeCity;

  afterEach(() => {
    useCityStore.setState({ activeCity: realCity });
    useGtfsDataStore.setState({ raptorIndex: null });
    useRtStore.setState({ updates: new Map() });
  });

  it("says it is no longer scheduled, shows no cancelled badge, and offers the next bus", () => {
    useCityStore.setState({ activeCity: { ...realCity, tz: "UTC" } });
    useGtfsDataStore.setState({ raptorIndex: lineThreeIndex });
    useRtStore.setState({ updates: new Map([["R3", [{ tripId: "T800", delaySeconds: 0, cancelled: false, deleted: true }]]]) });
    const trip = itinerary([
      walk({ from: place("Home"), to: place("Stop 1", 0, 0, "S1"), depart: "2026-09-25T07:52:00Z", arrive: "2026-09-25T07:56:00Z" }),
      { ...ride({ from: place("Stop 1", 0, 0, "S1"), to: place("Stop 2", 0, 0, "S2"), depart: "2026-09-25T08:00:00Z", arrive: "2026-09-25T08:10:00Z", routeShortName: "3" }), tripId: "T800", routeId: "R3" },
    ]);
    const { getByText, queryByText } = renderWithProviders(
      <RouteResultsConsumer itineraries={[trip]} onSelect={() => {}} referenceNowMs={ms("2026-09-25T07:55:00Z")} bufferSeconds={180} />,
    );
    expect(getByText("No longer scheduled · next in ~15 min")).toBeInTheDocument();
    expect(queryByText("Cancelled")).toBeNull();
  });
});
