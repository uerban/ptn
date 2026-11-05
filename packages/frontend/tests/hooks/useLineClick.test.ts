import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { LinePattern } from "../../src/stores/lineViewStore.ts";

vi.mock("../../src/utils/buildLinePatterns.ts", () => ({ buildLinePatterns: vi.fn() }));

import { buildLinePatterns } from "../../src/utils/buildLinePatterns.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useLineViewStore } from "../../src/stores/lineViewStore.ts";
import { useLineClick } from "../../src/hooks/useLineClick.ts";
import type { RaptorIndexRoute } from "../../src/services/raptorIndex.ts";
import { pattern, patternIndex } from "../../src/test-helpers/patternIndex.ts";

const PATTERNS: LinePattern[] = [
  { directionId: 0, headsign: "Airport", stops: [] },
  { directionId: 1, headsign: "Centre", stops: [] },
];

/**
 * `openLine` resolves to whether it showed the line, so a caller can tell a
 * line that showed from one that did not — including a re-show of the line
 * already on screen, which changes nothing a store subscriber could see.
 */
describe("useLineClick", () => {
  beforeEach(() => {
    vi.mocked(buildLinePatterns).mockResolvedValue(PATTERNS);
    useLineViewStore.getState().hideLine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useLineViewStore.getState().hideLine();
    useGtfsDataStore.setState({ raptorIndex: null });
  });

  it("shows the line in the headsign's direction and resolves true", async () => {
    const { result } = renderHook(() => useLineClick());
    await expect(result.current.openLine("1", "1", "e53935", "Centre")).resolves.toBe(true);
    const view = useLineViewStore.getState();
    expect(view).toMatchObject({ isVisible: true, activeRouteId: "1", activeDirection: 1 });
  });

  it("resolves true when re-showing the line already on screen", async () => {
    const { result } = renderHook(() => useLineClick());
    await result.current.openLine("1", "1", "e53935", "Airport");
    await expect(result.current.openLine("1", "1", "e53935", "Centre")).resolves.toBe(true);
    expect(useLineViewStore.getState().activeDirection).toBe(1);
  });

  it("resolves false when the route has no patterns", async () => {
    vi.mocked(buildLinePatterns).mockResolvedValue([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useLineClick());
    await expect(result.current.openLine("1", "1", undefined, "Centre")).resolves.toBe(false);
    expect(useLineViewStore.getState().isVisible).toBe(false);
  });

  it("resolves false when the load fails", async () => {
    vi.mocked(buildLinePatterns).mockRejectedValue(new Error("no index"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useLineClick());
    await expect(result.current.openLine("1", "1", undefined, "Centre")).resolves.toBe(false);
    expect(useLineViewStore.getState().isVisible).toBe(false);
  });

  it("resolves false for a load cancelled or superseded before it finished", async () => {
    const { result } = renderHook(() => useLineClick());
    const cancelled = result.current.openLine("1", "1", undefined, "Centre");
    result.current.cancel();
    await expect(cancelled).resolves.toBe(false);
    expect(useLineViewStore.getState().isVisible).toBe(false);

    const superseded = result.current.openLine("1", "1", undefined, "Centre");
    const latest = result.current.openLine("2", "2", undefined, "Airport");
    await expect(superseded).resolves.toBe(false);
    await expect(latest).resolves.toBe(true);
    expect(useLineViewStore.getState().activeRouteId).toBe("2");
  });

  // GTFS `trip_headsign` is rider-facing text the two directions of a route
  // may share; `direction_id` tells them apart:
  // https://gtfs.org/documentation/schedule/reference/#tripstxt
  describe("with the tapped departure's trip", () => {
    // Both directions of route 1 read "Centre", d1 listed first: the headsign
    // alone would open d1 whichever trip was tapped.
    const SHARED: LinePattern[] = [
      { directionId: 0, headsign: "Centre", stops: [], gtfsDirectionId: 1 },
      { directionId: 1, headsign: "Centre", stops: [], gtfsDirectionId: 0 },
    ];
    const OUT = pattern("1", ["A", "S", "B"], [{ tripId: "out", directionId: 0 }]);
    const BACK = pattern("1", ["B", "S", "A"], [{ tripId: "back", directionId: 1 }]);

    beforeEach(() => {
      vi.mocked(buildLinePatterns).mockResolvedValue(SHARED);
    });

    it("opens the trip's direction when both directions share the headsign", async () => {
      useGtfsDataStore.setState({ raptorIndex: patternIndex([OUT, BACK]) });
      const { result } = renderHook(() => useLineClick());
      await expect(result.current.openLine("1", "1", undefined, "Centre", "out")).resolves.toBe(true);
      expect(useLineViewStore.getState().activeDirection).toBe(1);
      await result.current.openLine("1", "1", undefined, "Centre", "back");
      expect(useLineViewStore.getState().activeDirection).toBe(0);
    });

    it("a trip folded into a longer pattern takes that pattern's direction", async () => {
      // CoveringMerge: the folded trip lost its own direction_id.
      const folded = pattern("1", ["A", "S", "B"], [
        { tripId: "out", directionId: 0 },
        { tripId: "short", departureSecs: [-1, 29000, 29120] },
      ]);
      useGtfsDataStore.setState({ raptorIndex: patternIndex([folded, BACK]) });
      const { result } = renderHook(() => useLineClick());
      await result.current.openLine("1", "1", undefined, "Centre", "short");
      expect(useLineViewStore.getState().activeDirection).toBe(1);
    });

    it("without patterns in the index, the trip's own direction_id decides", async () => {
      // PatternMode Off / the Dexie fallback: the canonical route only.
      const route: RaptorIndexRoute = pattern("1", ["A", "S", "B"], [
        { tripId: "out", directionId: 0 },
        { tripId: "back", directionId: 1, departureSecs: [-1, 29000, -1] },
      ]);
      useGtfsDataStore.setState({
        raptorIndex: { ...patternIndex(), routes: [route], routeIdToIdx: new Map([["1", 0]]) },
      });
      const { result } = renderHook(() => useLineClick());
      await result.current.openLine("1", "1", undefined, "Centre", "out");
      expect(useLineViewStore.getState().activeDirection).toBe(1);
    });

    it("picks the branch with the departure's headsign within the trip's direction", async () => {
      vi.mocked(buildLinePatterns).mockResolvedValue([
        { directionId: 0, headsign: "Depot", stops: [], gtfsDirectionId: 0 },
        { directionId: 1, headsign: "Depot", stops: [], gtfsDirectionId: 1 },
        { directionId: 2, headsign: "Airport", stops: [], gtfsDirectionId: 1 },
      ]);
      const airport = pattern("1", ["B", "S", "C"], [{ tripId: "air", headsign: "Airport", directionId: 1 }]);
      useGtfsDataStore.setState({ raptorIndex: patternIndex([OUT, BACK, airport]) });
      const { result } = renderHook(() => useLineClick());
      await result.current.openLine("1", "1", undefined, "Airport", "air");
      expect(useLineViewStore.getState().activeDirection).toBe(2);
      // No branch of that direction has the headsign: its first pattern.
      await result.current.openLine("1", "1", undefined, "Centre", "back");
      expect(useLineViewStore.getState().activeDirection).toBe(1);
    });

    it("falls back to the headsign when the index does not know the trip's direction", async () => {
      vi.mocked(buildLinePatterns).mockResolvedValue(PATTERNS);
      // A trip the index does not have.
      useGtfsDataStore.setState({ raptorIndex: patternIndex([OUT, BACK]) });
      const { result } = renderHook(() => useLineClick());
      await result.current.openLine("1", "1", undefined, "Centre", "gone");
      expect(useLineViewStore.getState().activeDirection).toBe(1);

      // A feed without direction_id.
      const undirected = pattern("1", ["A", "S"], [{ tripId: "plain" }]);
      useGtfsDataStore.setState({ raptorIndex: patternIndex([undirected]) });
      await result.current.openLine("1", "1", undefined, "Centre", "plain");
      expect(useLineViewStore.getState().activeDirection).toBe(1);
    });
  });
});
