import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useState, useEffect } from "react";
import { useLineViewStore } from "../../src/stores/lineViewStore.ts";
import type { LinePattern } from "../../src/stores/lineViewStore.ts";

/**
 * Minimal component that reproduces the popup/sheet dismissal coordination
 * from Home.tsx without dragging in all of Home's heavy dependencies.
 *
 * This mirrors lines 169-182 of Home.tsx exactly:
 *   const lineViewVisible = useLineViewStore((s) => s.isVisible);
 *   useEffect(() => { if (lineViewVisible) { setPopupStop(null); setSheetStop(null); } }, [lineViewVisible]);
 */
function TestCoordinator() {
  const lineViewVisible = useLineViewStore((s) => s.isVisible);
  const lineViewRouteId = useLineViewStore((s) => s.activeRouteId);
  const [popupStop, setPopupStop] = useState<string | null>("stop-1");
  const [sheetStop, setSheetStop] = useState<string | null>("stop-1");

  useEffect(() => {
    if (lineViewVisible) {
      setPopupStop(null);
      setSheetStop(null);
    }
  }, [lineViewVisible, lineViewRouteId]);

  return (
    <div>
      <span data-testid="popup">{popupStop ?? "none"}</span>
      <span data-testid="sheet">{sheetStop ?? "none"}</span>
      <button
        data-testid="set-stops"
        onClick={() => {
          setPopupStop("stop-2");
          setSheetStop("stop-2");
        }}
      />
    </div>
  );
}

const PATTERN: LinePattern = {
  directionId: 0,
  headsign: "Centre",
  stops: [
    { id: "s1", name: "A", location: { lat: 1, lon: 2 } },
    { id: "s2", name: "B", location: { lat: 3, lon: 4 } },
  ],
};

describe("Home line view coordination", () => {
  beforeEach(() => {
    useLineViewStore.getState().hideLine();
  });

  it("dismisses popup and sheet when line view becomes visible", () => {
    render(<TestCoordinator />);

    expect(screen.getByTestId("popup").textContent).toBe("stop-1");
    expect(screen.getByTestId("sheet").textContent).toBe("stop-1");

    act(() => {
      useLineViewStore.getState().showLine("r1", "142", "0073AC", [PATTERN]);
    });

    expect(screen.getByTestId("popup").textContent).toBe("none");
    expect(screen.getByTestId("sheet").textContent).toBe("none");
  });

  it("allows stops to be set again after line view is hidden", () => {
    render(<TestCoordinator />);

    // Open line view - dismisses stops
    act(() => {
      useLineViewStore.getState().showLine("r1", "142", null, [PATTERN]);
    });
    expect(screen.getByTestId("popup").textContent).toBe("none");

    // Close line view
    act(() => {
      useLineViewStore.getState().hideLine();
    });

    // User can set stops again
    act(() => {
      screen.getByTestId("set-stops").click();
    });
    expect(screen.getByTestId("popup").textContent).toBe("stop-2");
    expect(screen.getByTestId("sheet").textContent).toBe("stop-2");
  });

  it("replacing one line with another re-dismisses popup/sheet", () => {
    render(<TestCoordinator />);

    // Show first line
    act(() => {
      useLineViewStore.getState().showLine("r1", "1", null, [PATTERN]);
    });
    expect(screen.getByTestId("popup").textContent).toBe("none");

    // User somehow sets stops (shouldn't happen in real flow, but tests robustness)
    act(() => {
      screen.getByTestId("set-stops").click();
    });
    expect(screen.getByTestId("popup").textContent).toBe("stop-2");

    // Show a different line - should dismiss again because activeRouteId changed
    act(() => {
      useLineViewStore
        .getState()
        .showLine("r2", "3", "FF0000", [
          { ...PATTERN, headsign: "Airport" },
        ]);
    });

    // Effect now watches activeRouteId too, so it re-fires and dismisses
    expect(screen.getByTestId("popup").textContent).toBe("none");
    expect(screen.getByTestId("sheet").textContent).toBe("none");
    const store = useLineViewStore.getState();
    expect(store.activeRouteId).toBe("r2");
    expect(store.isVisible).toBe(true);
  });

  it("does not dismiss popup/sheet on mount when line view is already hidden", () => {
    // Ensure store starts hidden
    useLineViewStore.getState().hideLine();

    render(<TestCoordinator />);

    expect(screen.getByTestId("popup").textContent).toBe("stop-1");
    expect(screen.getByTestId("sheet").textContent).toBe("stop-1");
  });
});
