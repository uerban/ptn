import { describe, it, expect } from "vitest";
import { createGrowableU32 } from "./GrowableU32.js";

describe("GrowableU32", () => {
  it("starts empty with configurable initial capacity", () => {
    const g = createGrowableU32(8);
    expect(g.length).toBe(0);
  });

  it("push appends and grows", () => {
    const g = createGrowableU32(2);
    g.push(100);
    g.push(200);
    g.push(300);
    expect(g.length).toBe(3);
    expect(g.valueAt(0)).toBe(100);
    expect(g.valueAt(1)).toBe(200);
    expect(g.valueAt(2)).toBe(300);
  });

  it("slice returns a stable copy sized to length", () => {
    const g = createGrowableU32(4);
    g.push(1); g.push(2); g.push(3);
    const sliced = g.slice();
    expect(sliced).toBeInstanceOf(Uint32Array);
    expect(sliced.length).toBe(3);
    expect(Array.from(sliced)).toEqual([1, 2, 3]);
  });

  it("can grow beyond many doublings", () => {
    const g = createGrowableU32(4);
    for (let i = 0; i < 1000; i++) g.push(i);
    expect(g.length).toBe(1000);
    expect(g.valueAt(999)).toBe(999);
    const s = g.slice();
    expect(s.length).toBe(1000);
  });

  it("throws on out-of-range valueAt", () => {
    const g = createGrowableU32(4);
    g.push(1);
    expect(() => g.valueAt(-1)).toThrow();
    expect(() => g.valueAt(1)).toThrow();
  });

  it("rejects non-uint32 values", () => {
    const g = createGrowableU32(4);
    expect(() => g.push(-1)).toThrow();
    expect(() => g.push(1.5)).toThrow();
    expect(() => g.push(0x1_0000_0000)).toThrow();
  });
});
