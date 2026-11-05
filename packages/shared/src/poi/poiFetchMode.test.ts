import { describe, it, expect } from "vitest";
import { POI_FETCH_MODES, type PoiFetchMode } from "./poiFetchMode.js";

describe("PoiFetchMode", () => {
  it("enumerates exactly the three members (Phase 3 adds server-side)", () => {
    expect([...POI_FETCH_MODES]).toEqual(["eager-bundle", "lazy-tile", "server-side"]);
  });
  it("includes server-side", () => {
    expect((POI_FETCH_MODES as readonly string[]).includes("server-side")).toBe(true);
  });
  it("tuple length is 3", () => {
    expect(POI_FETCH_MODES).toHaveLength(3);
  });
  it("type accepts all three members", () => {
    const a: PoiFetchMode = "eager-bundle";
    const b: PoiFetchMode = "lazy-tile";
    const c: PoiFetchMode = "server-side";
    expect([a, b, c]).toHaveLength(3);
  });
});
