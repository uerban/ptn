import { describe, it, expect } from "vitest";
import {
  ymdLocal,
  addDaysYMD,
  yyyymmddToLocalMidnight,
  addDaysCivil,
  yyyymmddToLocalNoon,
} from "./ymd.js";

describe("ymdLocal", () => {
  it("formats a local-time Date as YYYYMMDD", () => {
    // 2026-05-04 08:30 local. Whatever the runtime TZ is, the y/m/d local fields are 2026/05/04.
    const d = new Date(2026, 4, 4, 8, 30);
    expect(ymdLocal(d)).toBe("20260504");
  });
  it("zero-pads single-digit months and days", () => {
    expect(ymdLocal(new Date(2026, 0, 9))).toBe("20260109");
  });
});

describe("addDaysYMD", () => {
  it("adds 1 day across a month boundary", () => {
    expect(addDaysYMD("20260131", 1)).toBe("20260201");
  });
  it("subtracts 1 day across a month boundary (Feb 28 in 2026, non-leap)", () => {
    expect(addDaysYMD("20260301", -1)).toBe("20260228");
  });
  it("adds 0 returns input unchanged", () => {
    expect(addDaysYMD("20260504", 0)).toBe("20260504");
  });
  it("crosses a year boundary forward", () => {
    expect(addDaysYMD("20261231", 1)).toBe("20270101");
  });
  it("crosses a year boundary backward", () => {
    expect(addDaysYMD("20260101", -1)).toBe("20251231");
  });
});

describe("yyyymmddToLocalMidnight", () => {
  it("returns a Date at local midnight for the given YMD", () => {
    const d = yyyymmddToLocalMidnight("20260504");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4);   // May
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
  it("matches `ymdLocal` when round-tripped", () => {
    expect(ymdLocal(yyyymmddToLocalMidnight("20260229"))).toBe("20260301");
    // 2026-02-29 doesn't exist (not leap); JS Date normalises to Mar 1 — confirm round-trip behaviour.
    expect(ymdLocal(yyyymmddToLocalMidnight("20260504"))).toBe("20260504");
  });
});

describe("addDaysCivil (pure, DST-safe)", () => {
  it("crosses month/year/leap boundaries", () => {
    expect(addDaysCivil("20260301", -1)).toBe("20260228");
    expect(addDaysCivil("20240301", -1)).toBe("20240229");
    expect(addDaysCivil("20260101", -1)).toBe("20251231");
    expect(addDaysCivil("20260505", -1)).toBe("20260504");
  });
  it("is invariant across spring-forward / fall-back DST days", () => {
    expect(addDaysCivil("20260329", -1)).toBe("20260328"); // EU spring-forward
    expect(addDaysCivil("20261025", 1)).toBe("20261026");  // EU fall-back
  });
});

describe("yyyymmddToLocalNoon", () => {
  it("returns local noon of the given civil date", () => {
    const d = yyyymmddToLocalNoon("20260504");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // May (0-based)
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(12);
  });
});
