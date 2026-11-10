import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSheetResize } from "./useSheetResize.ts";

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

function Harness() {
  const { height, grabProps } = useSheetResize("half");
  return (
    <div data-testid="sheet" data-h={height}>
      <div data-testid="grab" {...grabProps}>
        <button type="button" data-sheet-handle>handle</button>
        <h2 data-testid="title">Stop</h2>
        <button type="button" data-testid="close">x</button>
      </div>
    </div>
  );
}

const h = () => screen.getByTestId("sheet").dataset.h;
const swipe = (from: number, to: number) => {
  const grab = screen.getByTestId("grab");
  fireEvent.pointerDown(grab, { pointerId: 1, clientY: from, button: 0 });
  fireEvent.pointerMove(grab, { pointerId: 1, clientY: to });
  fireEvent.pointerUp(grab, { pointerId: 1 });
  fireEvent.click(grab);
};

describe("useSheetResize", () => {
  it("swipes up to grow and down to shrink, clamped", () => {
    render(<Harness />);
    swipe(300, 200);
    expect(h()).toBe("full");
    swipe(300, 200);
    expect(h()).toBe("full");
    swipe(200, 300);
    expect(h()).toBe("half");
    swipe(200, 300);
    expect(h()).toBe("peek");
  });

  it("ignores small movements", () => {
    render(<Harness />);
    const grab = screen.getByTestId("grab");
    fireEvent.pointerDown(grab, { pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(grab, { pointerId: 1, clientY: 290 });
    fireEvent.pointerUp(grab, { pointerId: 1 });
    expect(h()).toBe("half");
  });

  it("taps on the header cycle the size", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("title"));
    expect(h()).toBe("full");
  });

  it("taps on controls do not resize, the handle does", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("close"));
    expect(h()).toBe("half");
    fireEvent.click(screen.getByText("handle"));
    expect(h()).toBe("full");
  });
});
