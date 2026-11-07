import { describe, it, expect } from "vitest";
import type { PrivacyPolicy } from "@pt/shared";
import { compatLevelFloor } from "@pt/shared/privacy";
import { isTransitousAllowed } from "./transitousAvailability.ts";

describe("isTransitousAllowed (double-gate)", () => {
  it("allows only when remote residency AND third-party are both permitted", () => {
    expect(isTransitousAllowed(compatLevelFloor("baseline"))).toBe(true);
    expect(isTransitousAllowed(compatLevelFloor("standard"))).toBe(true);
    expect(isTransitousAllowed(compatLevelFloor("hardened"))).toBe(false);
    expect(isTransitousAllowed(compatLevelFloor("strict"))).toBe(false);
    expect(isTransitousAllowed(compatLevelFloor("paranoid"))).toBe(false);
  });

  it("is false when a user override disables third-party even at user-choice residency", () => {
    const overridden: PrivacyPolicy = { ...compatLevelFloor("standard"), m10ThirdPartyEnabled: false };
    expect(overridden.routingAdapter).toBe("user-choice"); // residency still allows remote
    expect(isTransitousAllowed(overridden)).toBe(false);    // but third-party gate closes it
  });

  it("is false when residency is local-only even if third-party is enabled", () => {
    const overridden: PrivacyPolicy = { ...compatLevelFloor("hardened"), m10ThirdPartyEnabled: true };
    expect(isTransitousAllowed(overridden)).toBe(false);
  });
});
