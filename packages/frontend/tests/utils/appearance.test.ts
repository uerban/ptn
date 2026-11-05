import { describe, it, expect } from "vitest";
import {
  getBadgeSize,
  getBadgeMinWidth,
  effectiveVariant,
} from "../../src/utils/appearance.ts";

describe("getBadgeSize", () => {
  it("maps each variant to its discrete badge size", () => {
    expect(getBadgeSize("consumer")).toBe("md");
    expect(getBadgeSize("power")).toBe("sm");
    expect(getBadgeSize("accessible")).toBe("lg");
  });

  it("returns identity-stable values across calls", () => {
    expect(getBadgeSize("consumer")).toBe(getBadgeSize("consumer"));
  });
});

describe("getBadgeMinWidth", () => {
  it("returns discrete CSS length per variant", () => {
    expect(getBadgeMinWidth("consumer")).toBe("2.25rem");
    expect(getBadgeMinWidth("power")).toBe("1.75rem");
    expect(getBadgeMinWidth("accessible")).toBe("3rem");
  });
});

describe("effectiveVariant", () => {
  it("upgrades vision_impaired to accessible regardless of selection", () => {
    expect(effectiveVariant("consumer", "vision_impaired")).toBe("accessible");
    expect(effectiveVariant("power", "vision_impaired")).toBe("accessible");
    expect(effectiveVariant("accessible", "vision_impaired")).toBe("accessible");
  });

  it("preserves explicit variant for default profile", () => {
    expect(effectiveVariant("consumer", "default")).toBe("consumer");
    expect(effectiveVariant("power", "default")).toBe("power");
    expect(effectiveVariant("accessible", "default")).toBe("accessible");
  });

  it("preserves explicit variant for wheelchair profile", () => {
    expect(effectiveVariant("power", "wheelchair")).toBe("power");
  });
});
