import { describe, it, expect } from "vitest";
import { isDayActive, type ServiceBitmask } from "./tables.js";

function mask(bits: number[], horizonDays = 16): ServiceBitmask {
  return {
    startDateIso: "2026-04-20",
    horizonDays,
    bits: new Uint8Array(bits),
  };
}

describe("isDayActive", () => {
  it("reads active bits correctly", () => {
    const m = mask([0b00000101], 8);
    expect(isDayActive(m, 0)).toBe(true);
    expect(isDayActive(m, 1)).toBe(false);
    expect(isDayActive(m, 2)).toBe(true);
    expect(isDayActive(m, 3)).toBe(false);
  });

  it("reads across byte boundaries", () => {
    const m = mask([0x00, 0x01], 16);
    expect(isDayActive(m, 7)).toBe(false);
    expect(isDayActive(m, 8)).toBe(true);
    expect(isDayActive(m, 9)).toBe(false);
  });

  it("returns false on out-of-range days", () => {
    const m = mask([0xFF], 8);
    expect(isDayActive(m, -1)).toBe(false);
    expect(isDayActive(m, 8)).toBe(false);
    expect(isDayActive(m, 1000)).toBe(false);
  });
});
