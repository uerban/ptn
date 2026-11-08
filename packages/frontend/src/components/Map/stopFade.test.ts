import { describe, expect, it, vi } from "vitest";
import type { StopWithLines } from "@pt/shared";
import { StopFade } from "./stopFade.ts";

const stop: StopWithLines = { id: "S", name: "Stop", location: { lat: 1, lon: 1 }, lines: [], lastSeen: 0 };
function setup() {
  let frame: FrameRequestCallback | undefined;
  let onscreen = true;
  let reduced = false;
  const prepareVisibility = vi.fn();
  const opacity = vi.fn();
  const changed = vi.fn();
  const cancelFrame = vi.fn(() => { frame = undefined; });
  const fades = new StopFade({
    prepareVisibility, onscreen: () => onscreen, reducedMotion: () => reduced, opacity, changed,
    requestFrame: callback => { frame = callback; return 1; }, cancelFrame,
  });
  const tick = (now: number) => { const callback = frame; frame = undefined; callback?.(now); };
  return { fades, prepareVisibility, opacity, changed, cancelFrame, tick,
    offscreen: () => { onscreen = false; }, reduce: () => { reduced = true; } };
}

describe("stop presentation exits", () => {
  it("fades an onscreen authoritative removal over 200ms and disables interaction immediately", () => {
    const { fades, opacity, changed, tick } = setup();
    fades.reconcile([stop], [stop], "a", 0);
    fades.reconcile([], [stop], "a", 10);
    expect(fades.exiting.get("S")?.stop).toBe(stop);
    expect(opacity).toHaveBeenLastCalledWith("S", 1, true);
    tick(110);
    expect(opacity).toHaveBeenLastCalledWith("S", 0.5, true);
    expect(changed).not.toHaveBeenCalled();
    tick(210);
    expect(fades.exiting.size).toBe(0);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("removes offscreen stops and catalog removals immediately", () => {
    const { fades, offscreen } = setup();
    fades.reconcile([stop], [stop], "a", 0);
    offscreen();
    fades.reconcile([], [stop], "a", 10);
    expect(fades.exiting.size).toBe(0);
    fades.reconcile([stop], [stop], "a", 20);
    fades.reconcile([], [], "a", 30);
    expect(fades.exiting.size).toBe(0);
  });

  it("drops an ongoing exit when panned out of the actual viewport", () => {
    const { fades, offscreen, tick, changed } = setup();
    fades.reconcile([stop], [stop], "a", 0);
    fades.reconcile([], [stop], "a", 10);
    offscreen();
    tick(11);
    expect(fades.exiting.size).toBe(0);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("cancels and restores opacity/interaction on reactivation, even after completion", () => {
    const { fades, opacity, tick } = setup();
    fades.reconcile([stop], [stop], "a", 0);
    fades.reconcile([], [stop], "a", 10);
    tick(110);
    fades.reconcile([stop], [stop], "a", 120);
    expect(fades.exiting.size).toBe(0);
    expect(opacity).toHaveBeenLastCalledWith("S", 1, false);
    fades.reconcile([], [stop], "a", 130);
    tick(330);
    fades.reconcile([stop], [stop], "a", 340);
    expect(opacity).toHaveBeenLastCalledWith("S", 1, false);
  });

  it("cancels on city/timetable context changes, including reused stop IDs", () => {
    const { fades, cancelFrame } = setup();
    const a = { city: "a", index: 1 };
    fades.reconcile([stop], [stop], a, 0);
    fades.reconcile([], [stop], a, 10);
    fades.reconcile([], [stop], { city: "a", index: 2 }, 20);
    expect(fades.exiting.size).toBe(0);
    expect(cancelFrame).toHaveBeenCalledOnce();
    fades.reconcile([stop], [stop], a, 30);
    fades.reconcile([], [stop], { city: "b", index: 1 }, 40);
    expect(fades.exiting.size).toBe(0);
  });

  it("respects reduced motion before and during a fade", () => {
    const first = setup();
    first.fades.reconcile([stop], [stop], "a", 0);
    first.reduce();
    first.fades.reconcile([], [stop], "a", 10);
    expect(first.fades.exiting.size).toBe(0);
    const second = setup();
    second.fades.reconcile([stop], [stop], "a", 0);
    second.fades.reconcile([], [stop], "a", 10);
    second.reduce();
    second.tick(11);
    expect(second.fades.exiting.size).toBe(0);
  });

  it("fades pending names when their first same-city catalog qualifies them inactive", () => {
    const {fades, tick, opacity} = setup();
    fades.reconcile([stop], [stop], {cityId: "a", generation: null}, 0);
    fades.reconcile([], [stop], {cityId: "a", generation: "feed"}, 10);
    expect(fades.exiting.has(stop.id)).toBe(true);
    tick(110);
    expect(opacity).toHaveBeenLastCalledWith(stop.id, .5, true);
  });

  it("keeps a fade through unchanged-generation refreshes but cancels real replacements", () => {
    const {fades} = setup();
    fades.reconcile([stop], [stop], {cityId: "a", generation: "first"}, 0);
    fades.reconcile([], [stop], {cityId: "a", generation: "first"}, 10);
    fades.reconcile([], [stop], {cityId: "a", generation: "first"}, 20);
    expect(fades.exiting.has(stop.id)).toBe(true);
    fades.reconcile([], [stop], {cityId: "a", generation: "second"}, 30);
    expect(fades.exiting.size).toBe(0);
  });

  it("prepares rendered visibility once per batch and keeps canceled inactive exits inert", () => {
    const {fades, prepareVisibility, opacity, tick} = setup();
    const other = {...stop, id: "other"};
    fades.reconcile([stop, other], [stop, other], "a", 0);
    fades.reconcile([], [stop, other], "a", 10);
    expect(prepareVisibility).toHaveBeenCalledTimes(2);
    tick(50);
    expect(prepareVisibility).toHaveBeenCalledTimes(3);
    fades.reconcile([], [stop, other], "b", 60);
    expect(opacity).toHaveBeenLastCalledWith("other", 0, true);
    expect(fades.exiting.size).toBe(0);
  });

  it("cancels animation and discards snapshots on unmount", () => {
    const { fades, cancelFrame, tick, changed } = setup();
    fades.reconcile([stop], [stop], "a", 0);
    fades.reconcile([], [stop], "a", 10);
    fades.dispose();
    tick(210);
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(fades.exiting.size).toBe(0);
    expect(changed).not.toHaveBeenCalled();
  });
});
