import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useFocusTrap,
  useAutoFocus,
  useArrowKeyNav,
  useReturnFocus,
} from "../../src/hooks/useFocusManagement.ts";

function createContainer(buttonCount: number): HTMLDivElement {
  const container = document.createElement("div");
  for (let i = 0; i < buttonCount; i++) {
    const btn = document.createElement("button");
    btn.textContent = `Button ${i}`;
    container.appendChild(btn);
  }
  document.body.appendChild(container);
  return container;
}

describe("useFocusTrap", () => {
  it("wraps focus from last to first on Tab", () => {
    const container = createContainer(3);
    const ref = { current: container };

    renderHook(() => useFocusTrap(ref));

    const buttons = container.querySelectorAll("button");
    const last = buttons[2];
    last.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    container.dispatchEvent(event);

    expect(document.activeElement).toBe(buttons[0]);
    document.body.removeChild(container);
  });

  it("wraps focus from first to last on Shift+Tab", () => {
    const container = createContainer(3);
    const ref = { current: container };

    renderHook(() => useFocusTrap(ref));

    const buttons = container.querySelectorAll("button");
    buttons[0].focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
    });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    container.dispatchEvent(event);

    expect(document.activeElement).toBe(buttons[2]);
    document.body.removeChild(container);
  });

  it("does not trap focus when enabled=false", () => {
    const container = createContainer(3);
    const ref = { current: container };

    renderHook(() => useFocusTrap(ref, false));

    const buttons = container.querySelectorAll("button");
    buttons[2].focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    // Trap inactive — focus stays where it was, no wrap intervention.
    expect(document.activeElement).toBe(buttons[2]);
    expect(event.defaultPrevented).toBe(false);
    document.body.removeChild(container);
  });
});

describe("useAutoFocus", () => {
  it("focuses first interactive element on trigger change", () => {
    const container = createContainer(2);
    const ref = { current: container };

    const { rerender } = renderHook(
      ({ trigger }) => useAutoFocus(ref, trigger),
      { initialProps: { trigger: 0 as unknown } },
    );

    expect(document.activeElement).toBe(container.querySelectorAll("button")[0]);

    // Move focus to a different element so we can detect re-focus
    document.body.focus();

    rerender({ trigger: 1 });
    expect(document.activeElement).toBe(container.querySelectorAll("button")[0]);

    document.body.removeChild(container);
  });

  it("focuses ref element directly when it is itself focusable", () => {
    const btn = document.createElement("button");
    btn.textContent = "Direct";
    document.body.appendChild(btn);
    const ref = { current: btn };

    renderHook(() => useAutoFocus(ref, 1));

    expect(document.activeElement).toBe(btn);
    document.body.removeChild(btn);
  });
});

describe("useReturnFocus", () => {
  it("restores focus to the previously active element on unmount", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const overlayBtn = document.createElement("button");
    overlayBtn.textContent = "Overlay";
    document.body.appendChild(overlayBtn);

    const { unmount } = renderHook(() => useReturnFocus());

    overlayBtn.focus();
    expect(document.activeElement).toBe(overlayBtn);

    unmount();

    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
    document.body.removeChild(overlayBtn);
  });

  it("does not throw when previous element is no longer in DOM", () => {
    const ephemeral = document.createElement("button");
    document.body.appendChild(ephemeral);
    ephemeral.focus();

    const { unmount } = renderHook(() => useReturnFocus());

    document.body.removeChild(ephemeral);

    expect(() => unmount()).not.toThrow();
  });
});

describe("useArrowKeyNav", () => {
  it("moves focus down on ArrowDown", () => {
    const container = createContainer(3);
    const ref = { current: container };

    const { result } = renderHook(() => useArrowKeyNav(ref));

    const buttons = container.querySelectorAll("button");
    buttons[0].focus();

    // Simulate ArrowDown
    const event = {
      key: "ArrowDown",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent;

    result.current(event);
    expect(document.activeElement).toBe(buttons[1]);
    expect(event.preventDefault).toHaveBeenCalled();

    document.body.removeChild(container);
  });

  it("wraps from last to first on ArrowDown", () => {
    const container = createContainer(3);
    const ref = { current: container };

    const { result } = renderHook(() => useArrowKeyNav(ref));

    const buttons = container.querySelectorAll("button");
    buttons[2].focus();

    const event = {
      key: "ArrowDown",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent;

    result.current(event);
    expect(document.activeElement).toBe(buttons[0]);

    document.body.removeChild(container);
  });

  it("moves focus up on ArrowUp", () => {
    const container = createContainer(3);
    const ref = { current: container };

    const { result } = renderHook(() => useArrowKeyNav(ref));

    const buttons = container.querySelectorAll("button");
    buttons[1].focus();

    const event = {
      key: "ArrowUp",
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent;

    result.current(event);
    expect(document.activeElement).toBe(buttons[0]);

    document.body.removeChild(container);
  });
});
