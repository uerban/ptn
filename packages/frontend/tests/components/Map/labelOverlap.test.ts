import { describe, it, expect } from "vitest";
import {
  resolveLabelOverlaps,
  labelBox,
  overlapArea,
  type LabelItem,
} from "../../../src/components/Map/labelOverlap.ts";

describe("labelBox", () => {
  it("places a right-anchored label to the right of the dot", () => {
    const b = labelBox(100, 100, 40, "right");
    expect(b.x).toBeGreaterThan(100);
  });
  it("places a left-anchored label entirely left of the dot", () => {
    const b = labelBox(100, 100, 40, "left");
    expect(b.x + b.w).toBeLessThanOrEqual(100);
  });
  it("places a top-anchored label above the dot", () => {
    const b = labelBox(100, 100, 40, "top");
    expect(b.y + b.h).toBeLessThanOrEqual(100);
  });
});

describe("overlapArea", () => {
  it("is zero for disjoint boxes", () => {
    expect(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 })).toBe(0);
  });
  it("is the intersection area for overlapping boxes", () => {
    expect(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(25);
  });
});

describe("resolveLabelOverlaps", () => {
  it("leaves well-separated labels untouched", () => {
    const items: LabelItem[] = [
      { x: 0, y: 0, width: 30, anchor: "right" },
      { x: 500, y: 500, width: 30, anchor: "right" },
    ];
    expect(resolveLabelOverlaps(items)).toEqual(["right", "right"]);
  });

  it("separates two labels forced to collide on the same side", () => {
    // Two dots stacked vertically, both labels to the right → boxes overlap.
    const items: LabelItem[] = [
      { x: 100, y: 100, width: 80, anchor: "right" },
      { x: 100, y: 108, width: 80, anchor: "right" },
    ];
    const before = [
      labelBox(items[0].x, items[0].y, items[0].width, items[0].anchor),
      labelBox(items[1].x, items[1].y, items[1].width, items[1].anchor),
    ];
    expect(overlapArea(before[0], before[1])).toBeGreaterThan(0);

    const out = resolveLabelOverlaps(items);
    const after = [
      labelBox(items[0].x, items[0].y, items[0].width, out[0]),
      labelBox(items[1].x, items[1].y, items[1].width, out[1]),
    ];
    expect(overlapArea(after[0], after[1])).toBe(0);
    expect(out[0] !== out[1] || out.some((a, i) => a !== items[i].anchor)).toBe(true);
  });

  it("is deterministic", () => {
    const items: LabelItem[] = [
      { x: 100, y: 100, width: 60, anchor: "right" },
      { x: 110, y: 104, width: 60, anchor: "right" },
      { x: 95, y: 112, width: 60, anchor: "right" },
    ];
    expect(resolveLabelOverlaps(items)).toEqual(resolveLabelOverlaps(items));
  });

  it("returns one anchor per input item, in order", () => {
    const items: LabelItem[] = [
      { x: 0, y: 0, width: 20, anchor: "top" },
      { x: 1000, y: 0, width: 20, anchor: "bottom" },
    ];
    const out = resolveLabelOverlaps(items);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("top");
    expect(out[1]).toBe("bottom");
  });
});
