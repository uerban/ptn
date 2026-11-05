import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, render } from "@testing-library/react";
import { useRegisterMapObstacle } from "../../src/hooks/useRegisterMapObstacle.ts";
import { useMapObstaclesStore } from "../../src/stores/mapObstaclesStore.ts";

describe("useRegisterMapObstacle", () => {
  beforeEach(() => {
    useMapObstaclesStore.setState({ obstacles: new Map() });
  });

  it("registers the element's rect under the given id on mount", () => {
    function Probe() {
      const ref = useRegisterMapObstacle<HTMLDivElement>("test-overlay");
      return <div ref={ref} data-testid="probe">overlay</div>;
    }
    const { unmount } = render(<Probe />);
    expect(useMapObstaclesStore.getState().obstacles.has("test-overlay")).toBe(true);
    unmount();
    expect(useMapObstaclesStore.getState().obstacles.has("test-overlay")).toBe(false);
  });

  it("clears the registration when enabled flips to false", () => {
    function Probe({ enabled }: { enabled: boolean }) {
      const ref = useRegisterMapObstacle<HTMLDivElement>("toggleable", enabled);
      return <div ref={ref}>overlay</div>;
    }
    const { rerender } = render(<Probe enabled={true} />);
    expect(useMapObstaclesStore.getState().obstacles.has("toggleable")).toBe(true);

    rerender(<Probe enabled={false} />);
    expect(useMapObstaclesStore.getState().obstacles.has("toggleable")).toBe(false);

    rerender(<Probe enabled={true} />);
    expect(useMapObstaclesStore.getState().obstacles.has("toggleable")).toBe(true);
  });

  it("does not register when enabled starts false", () => {
    function Probe() {
      const ref = useRegisterMapObstacle<HTMLDivElement>("never", false);
      return <div ref={ref}>overlay</div>;
    }
    render(<Probe />);
    expect(useMapObstaclesStore.getState().obstacles.has("never")).toBe(false);
  });

  it("renderHook compatibility — no element attached, hook is a no-op", () => {
    const { unmount } = renderHook(() =>
      useRegisterMapObstacle<HTMLDivElement>("orphan"),
    );
    expect(useMapObstaclesStore.getState().obstacles.has("orphan")).toBe(false);
    unmount();
    expect(useMapObstaclesStore.getState().obstacles.has("orphan")).toBe(false);
  });
});
