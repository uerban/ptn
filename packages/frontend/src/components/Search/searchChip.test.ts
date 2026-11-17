import { describe, expect, it } from "vitest";
import { searchChipClass } from "./searchChip.ts";

describe("searchChipClass", () => {
  it("gives every variant the same size and no height cap", () => {
    for (const v of ["selected", "idle", "on", "off"] as const) {
      const c = searchChipClass(v);
      expect(c).toContain("min-h-10");
      expect(c).toContain("text-xs");
      expect(c).not.toMatch(/max-h|min\(2\.5rem/);
    }
  });
  it("marks off by strike-through, never by fading", () => {
    expect(searchChipClass("off")).toContain("line-through");
    expect(searchChipClass("off")).not.toMatch(/opacity-/);
  });
});
