import { describe, expect, it } from "vitest";
import {
  compareLevels,
  isOnboardingPresetId,
  isPrivacyLevel,
  sanitizeProtectionOverrides,
} from "./privacy.js";

describe("privacy level guards", () => {
  it("accepts only known levels", () => {
    expect(isPrivacyLevel("strict")).toBe(true);
    expect(isPrivacyLevel("extreme")).toBe(false);
    expect(isPrivacyLevel(3)).toBe(false);
  });

  it("orders levels by strictness", () => {
    expect(compareLevels("standard", "strict")).toBeLessThan(0);
    expect(compareLevels("paranoid", "strict")).toBeGreaterThan(0);
    expect(compareLevels("strict", "strict")).toBe(0);
  });

  it("accepts only known setup presets", () => {
    expect(isOnboardingPresetId("recommended")).toBe(true);
    expect(isOnboardingPresetId("balanced")).toBe(false);
  });
});

describe("sanitizeProtectionOverrides", () => {
  it("keeps valid protection overrides only", () => {
    expect(
      sanitizeProtectionOverrides({
        m10Jitter: true,
        mapTapSnapRadiusMeters: 50,
        m9SelfHosted: "sometimes",
        realTimePolling: "off",
        unknownAxis: 1,
      }),
    ).toEqual({ m10Jitter: true, mapTapSnapRadiusMeters: 50 });
  });

  it("rejects negative or non-finite numbers and non-objects", () => {
    expect(sanitizeProtectionOverrides({ mapTapSnapRadiusMeters: -1 })).toEqual({});
    expect(sanitizeProtectionOverrides({ mapTapSnapRadiusMeters: Infinity })).toEqual({});
    expect(sanitizeProtectionOverrides(null)).toEqual({});
    expect(sanitizeProtectionOverrides(["m10Jitter"])).toEqual({});
  });
});
