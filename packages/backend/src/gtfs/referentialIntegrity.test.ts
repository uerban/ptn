import { describe, it, expect } from "vitest";
import { createOrphanTracker } from "./referentialIntegrity.js";

describe("createOrphanTracker", () => {
  it("starts at zero", () => {
    const t = createOrphanTracker({ threshold: 0.001 });
    expect(t.total).toBe(0);
    expect(t.orphan).toBe(0);
    expect(t.ratio()).toBe(0);
  });

  it("records counts via recordKnown/recordOrphan", () => {
    const t = createOrphanTracker({ threshold: 0.001 });
    for (let i = 0; i < 1000; i++) t.recordKnown();
    for (let i = 0; i < 2; i++) t.recordOrphan();
    expect(t.total).toBe(1002);
    expect(t.orphan).toBe(2);
    expect(t.ratio()).toBeCloseTo(2 / 1002, 6);
  });

  it("assertWithinThreshold passes when ratio below threshold", () => {
    const t = createOrphanTracker({ threshold: 0.001 });
    for (let i = 0; i < 10_000; i++) t.recordKnown();
    t.recordOrphan();
    expect(() => t.assertWithinThreshold()).not.toThrow();
  });

  it("assertWithinThreshold throws when ratio exceeds threshold", () => {
    const t = createOrphanTracker({ threshold: 0.001 });
    for (let i = 0; i < 100; i++) t.recordKnown();
    for (let i = 0; i < 5; i++) t.recordOrphan();
    expect(() => t.assertWithinThreshold()).toThrow(/orphan|integrity/i);
  });

  it("passes on empty total (degenerate case)", () => {
    const t = createOrphanTracker({ threshold: 0.001 });
    expect(() => t.assertWithinThreshold()).not.toThrow();
  });
});
