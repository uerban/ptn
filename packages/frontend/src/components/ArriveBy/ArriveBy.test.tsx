import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import type { BaseEndpoint, Itinerary } from "@pt/shared";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useRoutingStore } from "../../stores/routingStore.ts";
import type { PtRouterHandle } from "../../services/raptorWasm.ts";
import type {
  ArriveByChannel, ArriveBySearchInput, ArriveBySearchState,
} from "../../services/temporalArriveByClient.ts";
import type { ArriveByJourneyOption } from "../../services/temporalArriveByJourneys.ts";
import type { ArriveByFailure, ArriveBySelector } from "../../services/temporalArriveByResults.ts";
import { ArriveByResults } from "./ArriveByResults.tsx";
import { ArriveByToolbar } from "./ArriveByToolbar.tsx";
import { ARRIVE_BY_MARKS, type ArriveByCardsMark } from "./arriveByMarks.ts";
import { useArriveByUi } from "./arriveByUiStore.ts";

vi.mock("./arriveByQuery.ts", () => ({ prepareArriveBy: vi.fn() }));
import { prepareArriveBy } from "./arriveByQuery.ts";

const TZ = "Europe/Vilnius";
const ORIGIN: BaseEndpoint = { kind: "stop", stopId: "A", name: "A", lat: 54.7, lon: 25.2 };
const DEST: BaseEndpoint = { kind: "stop", stopId: "B", name: "B", lat: 54.8, lon: 25.3 };
const OTHER: BaseEndpoint = { kind: "stop", stopId: "C", name: "C", lat: 54.6, lon: 25.1 };
const SCOPE = { serviceDate: 20261012, windowStart: 21600, windowEnd: 36001, arrivalDeadline: 36000, maxRounds: 4,
  entryStops: [{ stopId: "A", walkSecs: 0 }], exitStops: [{ stopId: "B", walkSecs: 0 }] };
const INPUT: ArriveBySearchInput = {
  scope: SCOPE, mobilityProfile: "default", excludedModes: [], walkSpeedMps: 1.25, minTransferSecs: 120,
};

function option(name: string, dep: number, dur: number, selectors: ArriveBySelector[], transfers = 0): ArriveByJourneyOption {
  const w = { serviceDate: 20261012, routeIdx: 1, readerRouteIdx: 1, tripIdx: dep, boardPosition: 0, alightPosition: 1,
    boardSecs: dep, alightSecs: dep + dur, frequencyOffsetSecs: 0, frequencyInstance: false, inSeat: false };
  return {
    selectors,
    journey: {
      point: { departureSecs: dep, arrivalSecs: dep + dur, actualTransfers: transfers, totalWalkSecs: 0, transitRounds: 1,
        serviceDate: 20261012, witnessLegs: 1, witness: [w] },
      access: { stopId: "A", walkSecs: 0 },
      rides: [{ witness: w, routeId: `r-${name}`, routeShortName: name, routeColor: null, tripId: `t-${name}`, mode: "BUS",
        routeType: 3, fromStopId: "A", toStopId: "B", patternStopIds: ["A", "B"], approximate: false }],
      connections: [],
      egress: { fromStopId: "B", exitStopId: "B", physicalWalkSecs: 0, callerWalkSecs: 0 },
    },
  };
}
const LATEST = option("L1", 33000, 2400, ["latest-departure"]);
const FAST = option("F2", 30000, 1500, ["fastest"]);
const FEW = option("W3", 30000, 2400, ["fewest-transfers", "least-walking"]);

function state(status: ArriveBySearchState["status"], options: readonly ArriveByJourneyOption[] = [],
  failure: ArriveByFailure | null = null): ArriveBySearchState {
  return { status, options, failure, latestScan: null, selectorScans: { "fewest-transfers": null, "least-walking": null },
    latestSource: status === "pending" ? null : "request", marks: { start: 0 },
    ownerMarks: { "latest-departure": null, fastest: null, "fewest-transfers": null, "least-walking": null } };
}

interface Run { input: ArriveBySearchInput; onUpdate: (s: ArriveBySearchState) => void; cancelled: boolean }
let runs: Run[];
let channel: ArriveByChannel & { warm: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> };

function installRouter(withChannel = true): void {
  runs = [];
  channel = {
    state: () => null,
    setEnabled: vi.fn(),
    observeTransfers: vi.fn(),
    warm: vi.fn(async () => "ran" as const),
    search: vi.fn((input: ArriveBySearchInput, onUpdate: (s: ArriveBySearchState) => void) => {
      const run: Run = { input, onUpdate, cancelled: false };
      runs.push(run);
      onUpdate(state("pending"));
      return { done: new Promise<ArriveBySearchState>(() => {}), cancel: () => { run.cancelled = true; } };
    }),
  } as never;
  const router = { plan: vi.fn(), resolveTime: vi.fn(), setTransfers: vi.fn(), free: vi.fn(), isAlive: () => true,
    ...(withChannel ? { arriveBy: channel } : {}) } as unknown as PtRouterHandle;
  useGtfsDataStore.setState({ ptRouter: router });
}

const recommended = (arrival: string): Itinerary[] => [{
  legs: [], departureTime: arrival, arrivalTime: arrival, durationSeconds: 0, transfers: 0, walkingDistanceMeters: 0,
}];

function Page({ origin = ORIGIN, destination = DEST, page = [] as Itinerary[] }) {
  return (
    <MemoryRouter>
      <ArriveByToolbar origin={origin} destination={destination} recommended={page} recommendedInitial />
      <ArriveByResults origin={origin} destination={destination} onSelect={() => {}}>
        <div data-testid="normal-results">normal</div>
      </ArriveByResults>
    </MemoryRouter>
  );
}

const cardTexts = () => screen.queryAllByTestId("itinerary-card").map((c) => c.textContent ?? "");
const order = () => cardTexts().map((t) => ["L1", "F2", "W3"].find((n) => t.includes(n)));
const emit = (s: ArriveBySearchState, run = runs[runs.length - 1]!) => act(() => { run.onUpdate(s); });

async function applyDefault(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
  await waitFor(() => expect(channel.warm).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByTestId("arrive-by-apply"));
  await waitFor(() => expect(runs).toHaveLength(1));
}

beforeEach(() => {
  useArriveByUi.setState({ cityId: null, mode: "leave-now", draftMs: null, edited: false, draftVersion: 0, appliedMs: null, defaults: {} });
  useRoutingStore.setState({ ranking: "fastest" });
  useCityStore.setState({ activeCity: { ...useCityStore.getState().activeCity, tz: TZ } });
  vi.mocked(prepareArriveBy).mockReset().mockResolvedValue({
    kind: "ready",
    prepared: { input: INPUT, origin: { lat: 54.7, lon: 25.2 }, destination: { lat: 54.8, lon: 25.3 },
      stops: new Map(), runToCatchStops: new Set() },
  });
  installRouter();
  performance.clearMarks();
});
afterEach(cleanup);

describe("Arrive-by toolbar", () => {
  it("fills the default from the initial Recommended page and warms that query once, in Leave now (H75)", async () => {
    render(<Page page={recommended("2026-10-12T07:12:01Z")} />);
    const deadline = Date.parse("2026-10-12T07:13:00Z");
    await waitFor(() => expect(channel.warm).toHaveBeenCalledTimes(1));
    expect(useArriveByUi.getState().mode).toBe("leave-now");
    expect(prepareArriveBy).toHaveBeenCalledWith(ORIGIN, DEST, deadline, useGtfsDataStore.getState().ptRouter, "results");
    expect(channel.warm).toHaveBeenCalledWith(INPUT);
    await waitFor(() => expect(performance.getEntriesByName(ARRIVE_BY_MARKS.warm)).toHaveLength(1));
    expect(performance.getEntriesByName(ARRIVE_BY_MARKS.warm)[0]).toMatchObject({ detail: { result: "ran", deadlineMs: deadline, trigger: "results" } });
    // Choosing Arrive by fills that deadline and finds its query warm already.
    fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
    expect(screen.getByTestId("arrive-by-date")).toHaveValue("2026-10-12");
    expect(screen.getByTestId("arrive-by-time")).toHaveValue("10:13");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(channel.warm).toHaveBeenCalledTimes(1);
    expect(prepareArriveBy).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(0);
    expect(screen.getByTestId("normal-results")).toBeInTheDocument();
    expect(performance.getEntriesByName(ARRIVE_BY_MARKS.choose)).toHaveLength(1);
  });

  it("in Leave now, warms for each initial Recommended list, not for endpoints alone", async () => {
    const { rerender } = render(<Page />);
    rerender(<Page origin={OTHER} />);
    await act(async () => { await Promise.resolve(); });
    expect(channel.warm).not.toHaveBeenCalled();
    expect(prepareArriveBy).not.toHaveBeenCalled();
    const first = recommended("2026-10-12T07:12:01Z");
    rerender(<Page origin={OTHER} page={first} />);
    await waitFor(() => expect(channel.warm).toHaveBeenCalledTimes(1));
    // The same list again posts nothing; a new list (new settings) warms again.
    rerender(<Page origin={OTHER} page={first} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(channel.warm).toHaveBeenCalledTimes(1);
    rerender(<Page origin={OTHER} page={recommended("2026-10-12T07:12:01Z")} />);
    await waitFor(() => expect(channel.warm).toHaveBeenCalledTimes(2));
    // Not for a later page of the list.
    render(<MemoryRouter><ArriveByToolbar origin={ORIGIN} destination={DEST} recommended={first} recommendedInitial={false} /></MemoryRouter>);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(channel.warm).toHaveBeenCalledTimes(2);
  });

  it("choosing Arrive by warms when no shown list was warmed; back to Leave now posts nothing more", async () => {
    const { rerender } = render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
    await waitFor(() => expect(channel.warm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(performance.getEntriesByName(ARRIVE_BY_MARKS.warm)[0]).toMatchObject({ detail: { trigger: "choice" } }));
    fireEvent.click(screen.getByRole("button", { name: "Leave now" }));
    rerender(<Page />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(channel.warm).toHaveBeenCalledTimes(1);
  });

  it("posts no warm-up for deadline edits; Apply dispatches one search at the edited deadline", async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
    await waitFor(() => expect(channel.warm).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("arrive-by-date"), { target: { value: "2026-10-12" } });
    fireEvent.change(screen.getByTestId("arrive-by-time"), { target: { value: "10:00" } });
    fireEvent.click(screen.getByTestId("arrive-by-apply"));
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(channel.warm).toHaveBeenCalledTimes(1);
    expect(prepareArriveBy).toHaveBeenLastCalledWith(ORIGIN, DEST, Date.parse("2026-10-12T10:00:00+03:00"), expect.anything());
    expect(screen.getByTestId("arrive-by-apply")).toBeDisabled();
  });

  it("warms when the endpoints arrive after the choice", async () => {
    const { rerender } = render(<Page destination={null as unknown as BaseEndpoint} />);
    fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
    await act(async () => { await Promise.resolve(); });
    expect(channel.warm).not.toHaveBeenCalled();
    rerender(<Page />);
    await waitFor(() => expect(channel.warm).toHaveBeenCalledTimes(1));
  });

  it("resets to Leave now when the city changes", async () => {
    render(<Page />);
    await applyDefault();
    act(() => { useCityStore.setState({ activeCity: { ...useCityStore.getState().activeCity, id: "elsewhere" } }); });
    await waitFor(() => expect(screen.getByTestId("normal-results")).toBeInTheDocument());
    expect(useArriveByUi.getState().mode).toBe("leave-now");
    expect(runs[0]!.cancelled).toBe(true);
  });
});

describe("Arrive-by results", () => {
  it("shows loading, then the latest card, then every option latest first", async () => {
    render(<Page />);
    await applyDefault();
    expect(screen.queryByTestId("normal-results")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Finding the latest departure");
    expect(cardTexts()).toHaveLength(0);
    emit(state("latest", [LATEST]));
    await waitFor(() => expect(order()).toEqual(["L1"]));
    expect(screen.getByRole("status")).toHaveTextContent("Latest departure shown");
    emit(state("complete", [LATEST, FAST, FEW]));
    await waitFor(() => expect(order()).toEqual(["L1", "F2", "W3"]));
    expect(screen.getByRole("status")).toHaveTextContent("latest departure first");
    const shown = performance.getEntriesByName(ARRIVE_BY_MARKS.shown) as PerformanceMark[];
    expect(shown.map((m) => (m.detail as { status: string }).status)).toEqual(["latest", "complete"]);
  });

  it("marks the applied search's page steps (H73) without changing what it shows", async () => {
    render(<Page />);
    await applyDefault();
    expect(prepareArriveBy).toHaveBeenLastCalledWith(ORIGIN, DEST, expect.any(Number), expect.anything());
    emit(state("latest", [LATEST]));
    await waitFor(() => expect(order()).toEqual(["L1"]));
    const marks = (name: string) => performance.getEntriesByName(name) as PerformanceMark[];
    expect(marks(ARRIVE_BY_MARKS.effect)).toHaveLength(1);
    await waitFor(() => expect(marks(ARRIVE_BY_MARKS.view).map((m) => (m.detail as { status: string }).status))
      .toEqual(["pending", "latest"]));
    const cards = marks(ARRIVE_BY_MARKS.cards).map((m) => ({ end: m.startTime, ...(m.detail as ArriveByCardsMark) }));
    expect(cards.map((c) => [c.status, c.options, c.trips])).toEqual([["pending", 0, 0], ["latest", 1, 1]]);
    // The pending update has no cards, so it reads no table (H73 step 2).
    expect(cards[0]).toMatchObject({ routes: 0, tripsRead: cards[0]!.start, routesRead: cards[0]!.start });
    for (const c of cards) {
      expect(c.start).toBeLessThanOrEqual(c.tripsRead);
      expect(c.start).toBeLessThanOrEqual(c.routesRead);
      expect(Math.max(c.tripsRead, c.routesRead)).toBeLessThanOrEqual(c.end);
    }
  });

  it("reorders equal departures on a sort change without a new search", async () => {
    render(<Page />);
    await applyDefault();
    emit(state("complete", [LATEST, FAST, FEW]));
    await waitFor(() => expect(order()).toEqual(["L1", "F2", "W3"]));
    act(() => { useRoutingStore.setState({ ranking: "least_walking" }); });
    // Equal walking (none) falls back to duration; fewest transfers is equal too.
    expect(order()).toEqual(["L1", "F2", "W3"]);
    const few = option("W3", 30000, 2400, ["fewest-transfers", "least-walking"], 0);
    const fast = option("F2", 30000, 1500, ["fastest"], 2);
    emit(state("complete", [LATEST, fast, few]));
    act(() => { useRoutingStore.setState({ ranking: "fewest_transfers" }); });
    await waitFor(() => expect(order()).toEqual(["L1", "W3", "F2"]));
    act(() => { useRoutingStore.setState({ ranking: "fastest" }); });
    expect(order()).toEqual(["L1", "F2", "W3"]);
    expect(runs).toHaveLength(1);
  });

  it("says when no journey meets the deadline and offers leaving now", async () => {
    render(<Page />);
    await applyDefault();
    emit(state("complete", []));
    await waitFor(() => expect(screen.getByTestId("arrive-by-notice")).toHaveTextContent("No journey starting in the 4 hours"));
    fireEvent.click(screen.getByRole("button", { name: "Show journeys leaving now" }));
    expect(screen.getByTestId("normal-results")).toBeInTheDocument();
    expect(useArriveByUi.getState()).toMatchObject({ mode: "leave-now", appliedMs: null });
  });

  it("shows a failure with its stage and code, clears the latest card, and retries", async () => {
    render(<Page />);
    await applyDefault();
    emit(state("latest", [LATEST]));
    await waitFor(() => expect(order()).toEqual(["L1"]));
    emit(state("failed", [], { stage: "search", code: "WorkExhausted", message: "lookup" }));
    await waitFor(() => expect(screen.getByTestId("arrive-by-notice")).toHaveTextContent("failed (search/WorkExhausted)"));
    expect(cardTexts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[0]!.cancelled).toBe(true);
  });

  it("keeps certified latest visible with an incomplete notice, then clears on invalidation", async () => {
    render(<Page />); await applyDefault();
    emit(state("latest", [LATEST]));
    await waitFor(() => expect(order()).toEqual(["L1"]));
    emit(state("limited", [LATEST], { stage: "search", code: "ResourceLimit", resourceLimit: "lookup-work", message: "cap" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Other route options couldn’t be calculated"));
    expect(order()).toEqual(["L1"]);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show journeys leaving now" })).toBeInTheDocument();
    emit(state("cancelled"));
    await waitFor(() => expect(cardTexts()).toHaveLength(0));
  });

  it("re-runs the applied search when an endpoint changes", async () => {
    const { rerender } = render(<Page />);
    await applyDefault();
    rerender(<Page origin={OTHER} />);
    await waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[0]!.cancelled).toBe(true);
    expect(prepareArriveBy).toHaveBeenLastCalledWith(OTHER, DEST, expect.any(Number), expect.anything());
  });

  it("ignores a superseded search's late update", async () => {
    const { rerender } = render(<Page />);
    await applyDefault();
    rerender(<Page origin={OTHER} />);
    await waitFor(() => expect(runs).toHaveLength(2));
    emit(state("complete", [LATEST]));
    await waitFor(() => expect(order()).toEqual(["L1"]));
    emit(state("complete", [FAST]), runs[0]);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(order()).toEqual(["L1"]);
  });

  it("says Arrive by is unavailable without the channel", async () => {
    installRouter(false);
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
    fireEvent.click(screen.getByTestId("arrive-by-apply"));
    await waitFor(() => expect(screen.getByTestId("arrive-by-notice")).toHaveTextContent("not available"));
    expect(prepareArriveBy).not.toHaveBeenCalled();
  });

  it("reports endpoints without reachable stops", async () => {
    vi.mocked(prepareArriveBy).mockResolvedValue({ kind: "no-stops" });
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Arrive by" }));
    fireEvent.click(screen.getByTestId("arrive-by-apply"));
    await waitFor(() => expect(screen.getByTestId("arrive-by-notice")).toHaveTextContent("No transit stops"));
    expect(runs).toHaveLength(0);
  });
});
