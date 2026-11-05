import { describe, expect, it } from "vitest";
import { resolveTzState } from "./feedTz.ts";

describe("resolveTzState", () => {
  it("verified when config tz present and matches the bundle meta", () => {
    expect(resolveTzState("Europe/Vilnius", "Europe/Vilnius", "Europe/Vilnius")).toEqual({
      feedTz: "Europe/Vilnius",
      crossTz: false,
      unverified: false,
    });
  });

  it("crossTz=true when device tz differs from feed tz", () => {
    const s = resolveTzState("Europe/Vilnius", "Europe/Vilnius", "America/New_York");
    expect(s.crossTz).toBe(true);
    expect(s.unverified).toBe(false);
  });

  it("unverified + drift logged when config tz mismatches bundle meta", () => {
    const s = resolveTzState("Europe/Warsaw", "Europe/Vilnius", "America/New_York");
    // Config wins for display (it's the static SoT mirror), but flagged.
    expect(s.feedTz).toBe("Europe/Warsaw");
    expect(s.unverified).toBe(true);
  });

  it("absent bundle meta is NOT unverified (trust config, can't cross-check)", () => {
    const s = resolveTzState("Europe/Vilnius", undefined, "America/New_York");
    expect(s.unverified).toBe(false);
    expect(s.crossTz).toBe(true);
  });

  it("absent config tz → device-local + unverified", () => {
    const s = resolveTzState(undefined, "Europe/Vilnius", "America/New_York");
    expect(s.feedTz).toBeUndefined();
    expect(s.unverified).toBe(true);
  });

  it("absent config tz returns crossTz=false (not a tautology over deviceTz)", () => {
    // [R-fold v4 NIT] The no-config branch must report crossTz=false; the
    // device-time badge surfaces via `unverified` alone. (Was previously
    // `deviceTz !== undefined`, always true → meaningless.)
    const s = resolveTzState(undefined, undefined, "America/New_York");
    expect(s.crossTz).toBe(false);
    expect(s.unverified).toBe(true);
  });
});
