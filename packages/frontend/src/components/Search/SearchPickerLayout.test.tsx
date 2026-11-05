import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePickerViewport } from "./SearchPickerLayout.ts";
const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
afterEach(() => {
  if (original) Object.defineProperty(window, "visualViewport", original);
  else Reflect.deleteProperty(window, "visualViewport");
});
describe("search visual viewport fit", () => {
  it("tracks keyboard resize and pan offsets, then removes listeners on exit", () => {
    const viewport = Object.assign(new EventTarget(), { width: 360, height: 660, offsetTop: 0, offsetLeft: 0 });
    const remove = vi.spyOn(viewport, "removeEventListener");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    const { result, rerender } = renderHook(({ enabled }) => usePickerViewport(enabled), { initialProps: { enabled: true } });
    expect(result.current).toMatchObject({ height: 660, width: 360, top: 0 });
    act(() => { viewport.height = 360; viewport.offsetTop = 80; viewport.dispatchEvent(new Event("resize")); });
    expect(result.current).toMatchObject({ height: 360, top: 80 });
    act(() => { viewport.offsetTop = 100; viewport.dispatchEvent(new Event("scroll")); });
    expect(result.current?.top).toBe(100);
    rerender({ enabled: false });
    expect(result.current).toBeUndefined();
    expect(remove.mock.calls.map(call => call[0])).toEqual(["resize", "scroll"]);
  });
  it("falls back to window dimensions if the visual viewport API is absent", () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    const { result } = renderHook(() => usePickerViewport(true));
    expect(result.current).toMatchObject({ height: window.innerHeight, width: window.innerWidth, top: 0, left: 0 });
  });
});
