import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeviceHeading } from "../../src/hooks/useDeviceHeading.ts";

// jsdom has no DeviceOrientationEvent; the hook only needs the name to exist
// on window for the non-iOS auto-grant path.
class FakeDeviceOrientationEvent extends Event {}

function dispatchOrientation(alpha: number): void {
  const e = new Event("deviceorientation") as Event & { alpha?: number };
  e.alpha = alpha;
  window.dispatchEvent(e);
}

beforeEach(() => {
  vi.stubGlobal("DeviceOrientationEvent", FakeDeviceOrientationEvent);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDeviceHeading", () => {
  it("auto-grants on non-iOS and applies the first heading", () => {
    const { result } = renderHook(() => useDeviceHeading(true));
    expect(result.current.permissionState).toBe("granted");

    act(() => dispatchOrientation(350)); // Android alpha → heading 360-350 = 10
    expect(result.current.heading).toBe(10);
  });

  it("throttles sensor-rate events: drops updates inside the min interval", () => {
    const { result } = renderHook(() => useDeviceHeading(true));

    act(() => dispatchOrientation(350)); // heading 10, applied
    expect(result.current.heading).toBe(10);

    // 20 ms later (~sensor rate) a different heading arrives — inside the
    // 100 ms window, must be dropped.
    act(() => {
      vi.advanceTimersByTime(20);
      dispatchOrientation(340); // heading 20
    });
    expect(result.current.heading).toBe(10);

    // Past the window the same reading applies.
    act(() => {
      vi.advanceTimersByTime(150);
      dispatchOrientation(340);
    });
    expect(result.current.heading).toBe(20);
  });

  it("skips updates when the rounded degree is unchanged (sub-degree jitter)", () => {
    const { result } = renderHook(() => useDeviceHeading(true));

    act(() => dispatchOrientation(340)); // heading 20
    expect(result.current.heading).toBe(20);

    // Well past the throttle window, but 339.7 → 20.3 rounds to the same
    // whole degree — no re-render-triggering update.
    act(() => {
      vi.advanceTimersByTime(500);
      dispatchOrientation(339.7);
    });
    expect(result.current.heading).toBe(20);

    // A whole-degree move applies.
    act(() => {
      vi.advanceTimersByTime(500);
      dispatchOrientation(339); // heading 21
    });
    expect(result.current.heading).toBe(21);
  });

  it("does not listen when disabled", () => {
    const { result } = renderHook(() => useDeviceHeading(false));
    act(() => dispatchOrientation(350));
    expect(result.current.heading).toBeNull();
  });
});
