import { describe, it, expect, beforeEach } from "vitest";
import {
  useLineViewStore,
  type LinePattern,
} from "../../src/stores/lineViewStore.ts";

const PATTERN_A: LinePattern = {
  directionId: 0,
  headsign: "Central Station",
  stops: [
    { id: "s1", name: "Stop A", location: { lat: 54.35, lon: 18.65 } },
    { id: "s2", name: "Stop B", location: { lat: 54.36, lon: 18.66 } },
    { id: "s3", name: "Stop C", location: { lat: 54.37, lon: 18.67 } },
  ],
};

const PATTERN_B: LinePattern = {
  directionId: 1,
  headsign: "Airport",
  stops: [
    { id: "s3", name: "Stop C", location: { lat: 54.37, lon: 18.67 } },
    { id: "s2", name: "Stop B", location: { lat: 54.36, lon: 18.66 } },
    { id: "s1", name: "Stop A", location: { lat: 54.35, lon: 18.65 } },
  ],
};

describe("lineViewStore", () => {
  beforeEach(() => {
    useLineViewStore.setState({
      activeRouteId: null,
      activeRouteShortName: null,
      activeRouteColor: null,
      activeDirection: 0,
      patterns: [],
      isVisible: false,
    });
  });

  it("starts with line view hidden", () => {
    const state = useLineViewStore.getState();
    expect(state.isVisible).toBe(false);
    expect(state.activeRouteId).toBeNull();
    expect(state.patterns).toEqual([]);
  });

  it("showLine activates the line view with patterns", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", "0073AC", [PATTERN_A, PATTERN_B]);

    const state = useLineViewStore.getState();
    expect(state.isVisible).toBe(true);
    expect(state.activeRouteId).toBe("r1");
    expect(state.activeRouteShortName).toBe("142");
    expect(state.activeRouteColor).toBe("0073AC");
    expect(state.activeDirection).toBe(0);
    expect(state.patterns).toHaveLength(2);
  });

  it("hideLine clears all state", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", "0073AC", [PATTERN_A, PATTERN_B]);
    useLineViewStore.getState().hideLine();

    const state = useLineViewStore.getState();
    expect(state.isVisible).toBe(false);
    expect(state.activeRouteId).toBeNull();
    expect(state.activeRouteShortName).toBeNull();
    expect(state.patterns).toEqual([]);
    expect(state.activeDirection).toBe(0);
  });

  it("toggleDirection switches between 0 and 1", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", null, [PATTERN_A, PATTERN_B]);

    expect(useLineViewStore.getState().activeDirection).toBe(0);

    useLineViewStore.getState().toggleDirection();
    expect(useLineViewStore.getState().activeDirection).toBe(1);

    useLineViewStore.getState().toggleDirection();
    expect(useLineViewStore.getState().activeDirection).toBe(0);
  });

  it("toggleDirection is a no-op with only one pattern", () => {
    useLineViewStore.getState().showLine("r1", "142", null, [PATTERN_A]);

    useLineViewStore.getState().toggleDirection();
    expect(useLineViewStore.getState().activeDirection).toBe(0);
  });

  it("setDirection sets a specific direction", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", null, [PATTERN_A, PATTERN_B]);

    useLineViewStore.getState().setDirection(1);
    expect(useLineViewStore.getState().activeDirection).toBe(1);

    useLineViewStore.getState().setDirection(0);
    expect(useLineViewStore.getState().activeDirection).toBe(0);
  });

  it("setDirection ignores out-of-range values", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", null, [PATTERN_A, PATTERN_B]);

    useLineViewStore.getState().setDirection(5);
    expect(useLineViewStore.getState().activeDirection).toBe(0);

    useLineViewStore.getState().setDirection(-1);
    expect(useLineViewStore.getState().activeDirection).toBe(0);
  });

  it("showLine resets direction to 0", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", null, [PATTERN_A, PATTERN_B]);
    useLineViewStore.getState().setDirection(1);

    // Show a different line — direction resets
    useLineViewStore.getState().showLine("r2", "3", "FF0000", [PATTERN_B]);
    expect(useLineViewStore.getState().activeDirection).toBe(0);
    expect(useLineViewStore.getState().activeRouteId).toBe("r2");
  });

  it("showLine accepts an initialDirection", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", null, [PATTERN_A, PATTERN_B], 1);
    expect(useLineViewStore.getState().activeDirection).toBe(1);
  });

  it("toggleDirection cycles through all patterns", () => {
    const PATTERN_C: LinePattern = {
      directionId: 2,
      headsign: "Harbour",
      stops: [
        { id: "s4", name: "Stop D", location: { lat: 54.38, lon: 18.68 } },
      ],
    };
    useLineViewStore
      .getState()
      .showLine("r1", "142", null, [PATTERN_A, PATTERN_B, PATTERN_C]);

    expect(useLineViewStore.getState().activeDirection).toBe(0);
    useLineViewStore.getState().toggleDirection();
    expect(useLineViewStore.getState().activeDirection).toBe(1);
    useLineViewStore.getState().toggleDirection();
    expect(useLineViewStore.getState().activeDirection).toBe(2);
    useLineViewStore.getState().toggleDirection();
    expect(useLineViewStore.getState().activeDirection).toBe(0);
  });

  it("active pattern stops are accessible from the current direction", () => {
    useLineViewStore
      .getState()
      .showLine("r1", "142", null, [PATTERN_A, PATTERN_B]);

    const state = useLineViewStore.getState();
    const activePattern = state.patterns[state.activeDirection];
    expect(activePattern.headsign).toBe("Central Station");
    expect(activePattern.stops).toHaveLength(3);
    expect(activePattern.stops[0].id).toBe("s1");

    // Switch direction
    useLineViewStore.getState().toggleDirection();
    const state2 = useLineViewStore.getState();
    const activePattern2 = state2.patterns[state2.activeDirection];
    expect(activePattern2.headsign).toBe("Airport");
    expect(activePattern2.stops[0].id).toBe("s3");
  });

  it("handles null color gracefully", () => {
    useLineViewStore.getState().showLine("r1", "142", null, [PATTERN_A]);

    const state = useLineViewStore.getState();
    expect(state.activeRouteColor).toBeNull();
    expect(state.isVisible).toBe(true);
  });
});
