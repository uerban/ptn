import { describe, it, expect } from "vitest";
import { lowerBound } from "./binarySearch.js";

describe("lowerBound", () => {
  const arr = [10, 20, 30, 40, 50].map((v) => ({ v }));
  const key = (x: { v: number }) => x.v;

  it("returns 0 when target is less than all elements", () => {
    expect(lowerBound(arr, 5, key)).toBe(0);
  });
  it("returns arr.length when target is greater than all elements", () => {
    expect(lowerBound(arr, 999, key)).toBe(arr.length);
  });
  it("returns index of first element >= target when target matches exactly", () => {
    expect(lowerBound(arr, 30, key)).toBe(2);
  });
  it("returns index of first element >= target when target is between", () => {
    expect(lowerBound(arr, 25, key)).toBe(2);
  });
  it("returns 0 on an empty array", () => {
    expect(lowerBound<{ v: number }>([], 42, (x) => x.v)).toBe(0);
  });
});
