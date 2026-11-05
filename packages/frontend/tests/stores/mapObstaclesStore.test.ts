import { describe, it, expect, beforeEach } from "vitest";
import { useMapObstaclesStore } from "../../src/stores/mapObstaclesStore.ts";

describe("mapObstaclesStore", () => {
  beforeEach(() => {
    useMapObstaclesStore.setState({ obstacles: new Map() });
  });

  it("starts empty", () => {
    expect(useMapObstaclesStore.getState().obstacles.size).toBe(0);
  });

  it("setObstacle adds a rect by id", () => {
    useMapObstaclesStore
      .getState()
      .setObstacle("step-list", { left: 0, top: 600, right: 800, bottom: 1000 });
    const obs = useMapObstaclesStore.getState().obstacles;
    expect(obs.size).toBe(1);
    expect(obs.get("step-list")).toEqual({ left: 0, top: 600, right: 800, bottom: 1000 });
  });

  it("setObstacle replaces an existing rect under the same id", () => {
    const s = useMapObstaclesStore.getState();
    s.setObstacle("step-list", { left: 0, top: 600, right: 800, bottom: 1000 });
    s.setObstacle("step-list", { left: 0, top: 500, right: 800, bottom: 1000 });
    expect(useMapObstaclesStore.getState().obstacles.get("step-list"))
      .toEqual({ left: 0, top: 500, right: 800, bottom: 1000 });
  });

  it("setObstacle is a no-op when the rect is unchanged (preserves Map identity)", () => {
    const s = useMapObstaclesStore.getState();
    const rect = { left: 0, top: 600, right: 800, bottom: 1000 };
    s.setObstacle("step-list", rect);
    const mapBefore = useMapObstaclesStore.getState().obstacles;
    s.setObstacle("step-list", { ...rect });
    const mapAfter = useMapObstaclesStore.getState().obstacles;
    // No change → same Map reference. This matters: TransitMap subscribes to
    // the Map identity and skips re-placement if it hasn't changed.
    expect(mapAfter).toBe(mapBefore);
  });

  it("clearObstacle removes a rect", () => {
    const s = useMapObstaclesStore.getState();
    s.setObstacle("step-list", { left: 0, top: 600, right: 800, bottom: 1000 });
    s.clearObstacle("step-list");
    expect(useMapObstaclesStore.getState().obstacles.size).toBe(0);
  });

  it("clearObstacle on a missing id is a no-op", () => {
    const s = useMapObstaclesStore.getState();
    const before = useMapObstaclesStore.getState().obstacles;
    s.clearObstacle("never-set");
    expect(useMapObstaclesStore.getState().obstacles).toBe(before);
  });

  it("multiple obstacles coexist independently", () => {
    const s = useMapObstaclesStore.getState();
    s.setObstacle("a", { left: 0, top: 0, right: 100, bottom: 50 });
    s.setObstacle("b", { left: 200, top: 0, right: 300, bottom: 50 });
    s.setObstacle("c", { left: 0, top: 600, right: 400, bottom: 800 });
    expect(useMapObstaclesStore.getState().obstacles.size).toBe(3);
    s.clearObstacle("b");
    expect(useMapObstaclesStore.getState().obstacles.size).toBe(2);
    expect(useMapObstaclesStore.getState().obstacles.has("a")).toBe(true);
    expect(useMapObstaclesStore.getState().obstacles.has("c")).toBe(true);
  });
});
