import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSheetResize, OBSTACLES_REFRESH_EVENT, SHEET_DRAGGING_ATTR } from "./useSheetResize.ts";

// jsdom has no PointerEvent; give it the fields the hook reads.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventStub extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "touch";
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: PointerEventStub, configurable: true });
}

const PRESETS = { peek: 120, half: 400, full: 700 };

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  const { height, grabProps, sheetProps } = useSheetResize(ref, PRESETS, "half");
  return (
    <div ref={ref} data-testid="sheet" data-h={height} {...sheetProps}>
      <div data-testid="grab" {...grabProps}>
        <button type="button" data-sheet-handle>handle</button>
        <h2 data-testid="title">Stop</h2>
        <button type="button" data-testid="close">x</button>
      </div>
    </div>
  );
}

const sheet = () => screen.getByTestId("sheet");
const h = () => sheet().dataset.h;
const maxH = () => sheet().style.maxHeight;

/** Press at `from`, move to each y in turn, release. */
const drag = (from: number, ...to: number[]) => {
  const grab = screen.getByTestId("grab");
  fireEvent.pointerDown(grab, { pointerId: 1, clientY: from, button: 0 });
  for (const y of to) {
    fireEvent.pointerMove(grab, { pointerId: 1, clientY: y });
    vi.advanceTimersToNextFrame();
  }
  fireEvent.pointerUp(grab, { pointerId: 1 });
  fireEvent.click(grab);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 400 } as DOMRect);
  HTMLElement.prototype.setPointerCapture = () => {};
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("useSheetResize", () => {
  it("follows the finger to any height and keeps it", () => {
    render(<Harness />);
    drag(500, 450, 380); // up 120 -> 520
    expect(maxH()).toBe("520px");
    expect(h()).toBe("half");
  });

  it("clamps between the peek and full sizes", () => {
    render(<Harness />);
    drag(500, 0);
    expect(maxH()).toBe("700px");
    drag(500, 2000);
    expect(maxH()).toBe("120px");
    expect(h()).toBe("peek");
  });

  it("snaps to a preset when released near one", () => {
    render(<Harness />);
    drag(500, 490, 480); // 400 + 20 -> 420, within 24px of half
    expect(maxH()).toBe("400px");
  });

  it("pauses map obstacle tracking while dragging and refreshes once after", () => {
    render(<Harness />);
    const refresh = vi.fn();
    window.addEventListener(OBSTACLES_REFRESH_EVENT, refresh);
    const grab = screen.getByTestId("grab");
    fireEvent.pointerDown(grab, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(grab, { pointerId: 1, clientY: 420 });
    expect(document.documentElement.hasAttribute(SHEET_DRAGGING_ATTR)).toBe(true);
    fireEvent.pointerUp(grab, { pointerId: 1 });
    expect(document.documentElement.hasAttribute(SHEET_DRAGGING_ATTR)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    window.removeEventListener(OBSTACLES_REFRESH_EVENT, refresh);
  });

  it("treats small movements as taps, not drags", () => {
    render(<Harness />);
    const grab = screen.getByTestId("grab");
    fireEvent.pointerDown(grab, { pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(grab, { pointerId: 1, clientY: 297 });
    fireEvent.pointerUp(grab, { pointerId: 1 });
    expect(maxH()).toBe("400px");
    expect(document.documentElement.hasAttribute(SHEET_DRAGGING_ATTR)).toBe(false);
  });

  it("taps on the header cycle the presets", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("title"));
    expect(h()).toBe("full");
    fireEvent.click(screen.getByTestId("title"));
    expect(h()).toBe("peek");
  });

  it("taps on controls do not resize, the handle does", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("close"));
    expect(h()).toBe("half");
    fireEvent.click(screen.getByText("handle"));
    expect(h()).toBe("full");
  });
});
