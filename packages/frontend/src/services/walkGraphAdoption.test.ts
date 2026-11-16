import {afterEach, describe, expect, it, vi} from "vitest";
import {useGuidanceStore} from "../stores/guidanceStore.ts";
import {installWalkGraphAdoption, WALK_GRAPH_ADOPTION_MS} from "./walkGraphAdoption.ts";
import {walkGraphClient} from "./walkGraphClient.ts";
describe("walk graph session adoption", () => {
  afterEach(() => {
    useGuidanceStore.setState({phase: "idle"});
    vi.useRealTimers();
  });
  it("defers periodic and foreground resets during guidance, then resets at its end", () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    const dispose = installWalkGraphAdoption(reset);
    useGuidanceStore.setState({phase: "navigating"});
    vi.advanceTimersByTime(WALK_GRAPH_ADOPTION_MS * 2);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reset).not.toHaveBeenCalled();
    useGuidanceStore.setState({phase: "idle"});
    expect(reset).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WALK_GRAPH_ADOPTION_MS);
    expect(reset).toHaveBeenCalledTimes(2);
    dispose();
    vi.advanceTimersByTime(WALK_GRAPH_ADOPTION_MS);
    expect(reset).toHaveBeenCalledTimes(2);
  });
  it("defers adoption between pedestrian queries until all searches release", () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    const dispose = installWalkGraphAdoption(reset);
    const releaseFirst = walkGraphClient.retainForSearch();
    const releaseSecond = walkGraphClient.retainForSearch();
    try {
      vi.advanceTimersByTime(WALK_GRAPH_ADOPTION_MS);
      document.dispatchEvent(new Event("visibilitychange"));
      useGuidanceStore.setState({phase: "navigating"});
      useGuidanceStore.setState({phase: "idle"});
      expect(reset).not.toHaveBeenCalled();
      releaseFirst();
      vi.advanceTimersByTime(WALK_GRAPH_ADOPTION_MS);
      expect(reset).not.toHaveBeenCalled();
      releaseSecond();
      vi.advanceTimersByTime(WALK_GRAPH_ADOPTION_MS);
      expect(reset).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      releaseSecond();
      dispose();
    }
  });
});
