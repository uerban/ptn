import { describe, it, expect } from "vitest";
import type { PrivacyPolicy } from "@pt/shared";
import { LEVEL_FLOORS } from "@pt/shared/privacy";
import { isTransitousAllowed } from "./transitousAvailability.ts";

describe("isTransitousAllowed (double-gate)", () => {
  it("allows only when remote residency AND third-party are both permitted", () => {
    expect(isTransitousAllowed(LEVEL_FLOORS.baseline)).toBe(true);
    expect(isTransitousAllowed(LEVEL_FLOORS.standard)).toBe(true);
    expect(isTransitousAllowed(LEVEL_FLOORS.hardened)).toBe(false);
    expect(isTransitousAllowed(LEVEL_FLOORS.strict)).toBe(false);
    expect(isTransitousAllowed(LEVEL_FLOORS.paranoid)).toBe(false);
  });

  it("is false when a user override disables third-party even at user-choice residency", () => {
    const overridden: PrivacyPolicy = { ...LEVEL_FLOORS.standard, m10ThirdPartyEnabled: false };
    expect(overridden.routingAdapter).toBe("user-choice"); // residency still allows remote
    expect(isTransitousAllowed(overridden)).toBe(false);    // but third-party gate closes it
  });

  it("is false when residency is local-only even if third-party is enabled", () => {
    const overridden: PrivacyPolicy = { ...LEVEL_FLOORS.hardened, m10ThirdPartyEnabled: true };
    expect(isTransitousAllowed(overridden)).toBe(false);
  });
});
