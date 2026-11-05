import { describe, it, expect } from "vitest";
import {
  quantizeViewportBounds,
  VIEWPORT_QUANTIZE_STEP_DEG as STEP,
  type MapViewportBounds,
} from "./mapViewportStore.ts";

// Anchor a value at the middle of its grid cell so a sub-step nudge provably
// stays in the same cell (independent of the exact STEP value).
const midCell = (v: number) => (Math.floor(v / STEP) + 0.5) * STEP;

function viewport(north: number, south: number, east: number, west: number): MapViewportBounds {
  return { north, south, east, west };
}

describe("quantizeViewportBounds", () => {
  it("maps a sub-cell pan to identical bounds (so the badge effect deps don't change)", () => {
    const base = viewport(midCell(54.69), midCell(54.67), midCell(25.29), midCell(25.27));
    const nudge = STEP * 0.2; // a fraction of a cell — a tiny pan
    const nudged = viewport(base.north + nudge, base.south + nudge, base.east + nudge, base.west + nudge);
    // Quantization collapses both to the same grid cell → React sees identical
    // primitive deps → useViewportBadgeActivity does NOT re-run (no recompute).
    expect(quantizeViewportBounds(nudged)).toEqual(quantizeViewportBounds(base));
  });

  it("changes when a viewport edge crosses a grid line (a real move still recomputes)", () => {
    const base = viewport(midCell(54.69), midCell(54.67), midCell(25.29), midCell(25.27));
    const crossed = viewport(base.north + STEP * 1.5, base.south, base.east, base.west);
    expect(quantizeViewportBounds(crossed).north).not.toEqual(quantizeViewportBounds(base).north);
  });

  it("never shrinks the bounds (outward rounding keeps coverage a superset)", () => {
    const raw = viewport(54.6853, 54.6647, 25.2851, 25.2649);
    const q = quantizeViewportBounds(raw);
    expect(q.north).toBeGreaterThanOrEqual(raw.north);
    expect(q.south).toBeLessThanOrEqual(raw.south);
    expect(q.east).toBeGreaterThanOrEqual(raw.east);
    expect(q.west).toBeLessThanOrEqual(raw.west);
  });

  it("is idempotent (already-quantized bounds are a fixed point)", () => {
    const raw = viewport(54.6853, 54.6647, 25.2851, 25.2649);
    const once = quantizeViewportBounds(raw);
    expect(quantizeViewportBounds(once)).toEqual(once);
  });
});
