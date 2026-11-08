import { describe, expect, it } from "vitest";
import { guidancePadding } from "./guidancePadding.ts";

const map = { top: 100, bottom: 1100, left: 20, right: 820 };
describe("guidancePadding", () => {
  it("fits into the exposed map above a panel covering 40 percent", () => {
    expect(guidancePadding(map, { top: 700, bottom: 1100, left: 20, right: 820 }, 50))
      .toEqual({ top: 50, right: 50, bottom: 450, left: 50 });
  });
  it("uses equal margins without an overlapping panel", () => {
    expect(guidancePadding(map, undefined, 50).bottom).toBe(50);
    expect(guidancePadding(map, { top: 700, bottom: 1100, left: 900, right: 1200 }, 50).bottom).toBe(50);
  });
  it("keeps a fitting area when the panel covers the map", () => {
    expect(guidancePadding(map, { top: 0, bottom: 1100, left: 20, right: 820 }, 50).bottom).toBe(949);
  });
});
