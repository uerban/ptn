import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentRow } from "./RecentRow.tsx";
import { RecentNotice, UNDO_WINDOW_MS } from "./RecentNotice.tsx";

// jsdom has no PointerEvent; a MouseEvent carries the coordinates.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderRow() {
  const onSave = vi.fn();
  const onRemove = vi.fn();
  const onSelect = vi.fn();
  render(
    <RecentRow
      label="Central"
      onSave={onSave}
      onRemove={onRemove}
      text={{ actions: "More for {label}", save: "Save place", remove: "Remove from recents" }}
    >
      <button type="button" role="option" aria-selected={false} onClick={onSelect}>
        Central
      </button>
    </RecentRow>,
  );
  return { onSave, onRemove, onSelect };
}

function swipe(dx: number, startX = 100) {
  const row = screen.getByTestId("recent-row");
  fireEvent.pointerDown(row, { pointerType: "touch", clientX: startX, clientY: 10 });
  fireEvent.pointerMove(row, { pointerType: "touch", clientX: startX + dx / 2, clientY: 10 });
  fireEvent.pointerMove(row, { pointerType: "touch", clientX: startX + dx, clientY: 10 });
  fireEvent.pointerUp(row, { pointerType: "touch", clientX: startX + dx, clientY: 10 });
}

describe("RecentRow", () => {
  it("offers Save and Remove from a visible menu, keyboard first", () => {
    const { onSave, onRemove } = renderRow();
    const more = screen.getByRole("button", { name: "More for Central" });
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(more);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Save place" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Remove from recents" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Save place" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("swipe right saves, swipe left removes, and neither selects the row", () => {
    const { onSave, onRemove, onSelect } = renderRow();
    swipe(120);
    fireEvent.click(screen.getByRole("option"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    swipe(-120);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("ignores short swipes and swipes from the screen edge", () => {
    const { onSave, onRemove } = renderRow();
    swipe(40);
    swipe(120, 5);
    expect(onSave).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("opens the same menu on a long press", () => {
    vi.useFakeTimers();
    renderRow();
    fireEvent.pointerDown(screen.getByTestId("recent-row"), { pointerType: "touch", clientX: 100, clientY: 10 });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});

describe("RecentNotice", () => {
  const text = { saved: "Saved {label}", removed: "Removed {label}", undo: "Undo" };

  it("makes a removal final only after the Undo window", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const undo = vi.fn();
    const onDone = vi.fn();
    render(<RecentNotice notice={{ kind: "removed", label: "Central", commit, undo }} onDone={onDone} text={text} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(UNDO_WINDOW_MS - 1));
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalled();
  });

  it("Undo restores and never removes", () => {
    const commit = vi.fn();
    const undo = vi.fn();
    render(<RecentNotice notice={{ kind: "removed", label: "Central", commit, undo }} onDone={() => {}} text={text} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    cleanup();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
