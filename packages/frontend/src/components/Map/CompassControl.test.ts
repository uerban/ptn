import { describe, expect, it, vi } from "vitest";
import { COMPASS_LINGER_MS, CompassControl } from "./CompassControl.ts";

function fakeMap(bearing: number, pitch = 0) {
  const handlers: Record<string, () => void> = {};
  const map = {
    bearing,
    pitch,
    getBearing: () => map.bearing,
    getPitch: () => map.pitch,
    on: (e: string, h: () => void) => { handlers[e] = h; },
    off: vi.fn(),
    easeTo: vi.fn(),
    fire: (e: string) => handlers[e]?.(),
  };
  return map;
}

describe("CompassControl", () => {
  it("hides at north, shows the needle when rotated, and taps back to north", () => {
    const map = fakeMap(0);
    const control = new CompassControl((_k, f) => f ?? "");
    const el = control.onAdd(map as never);
    document.body.appendChild(el);
    expect(el.hidden).toBe(true);
    map.bearing = 45;
    map.fire("rotate");
    expect(el.hidden).toBe(false);
    const button = el.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Turn map to north");
    expect((el.querySelector("svg") as SVGElement).style.transform).toBe("rotate(-45deg)");
    button.click();
    expect(map.easeTo).toHaveBeenCalledWith({ bearing: 0, pitch: 0 });
  });

  it("lingers at north, then fades out, and comes back on rotation", () => {
    vi.useFakeTimers();
    const map = fakeMap(30);
    const el = new CompassControl((_k, f) => f ?? "").onAdd(map as never);
    map.bearing = 0;
    map.fire("rotate");
    vi.advanceTimersByTime(COMPASS_LINGER_MS - 1);
    expect(el.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains("ptn-compass-fading")).toBe(true);
    vi.advanceTimersByTime(300);
    expect(el.hidden).toBe(true);
    map.bearing = 10;
    map.fire("rotate");
    expect(el.hidden).toBe(false);
    vi.useRealTimers();
  });

  it("shows when only tilted", () => {
    const map = fakeMap(0, 30);
    const el = new CompassControl((_k, f) => f ?? "").onAdd(map as never);
    expect(el.hidden).toBe(false);
  });
});
