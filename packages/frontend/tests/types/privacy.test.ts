import { describe, expect, it } from "vitest";
import {
  AXIS_STRICTNESS_ORDER,
  effectivePolicy,
  legacyEffectiveNetworkPolicy,
  LEGACY_NETWORK_FLOORS_V1,
  LEVEL_FLOORS,
  PRIVACY_LEVELS,
  stricterValue,
  type PrivacyLevel,
  type PrivacyPolicy,
} from "@pt/shared";

describe("effectivePolicy", () => {
  it("returns LEVEL_FLOORS[level] when no overrides are supplied", () => {
    for (const level of PRIVACY_LEVELS) {
      expect(effectivePolicy(level)).toEqual(LEVEL_FLOORS[level]);
    }
  });

  it("applies a stricter override on an enum axis", () => {
    const policy = effectivePolicy("baseline", { urlShare: "coords-stripped" });
    expect(policy.urlShare).toBe("coords-stripped");
  });

  it("rejects an override weaker than the floor (returns the floor value)", () => {
    const policy = effectivePolicy("hardened", { urlShare: "coords-raw" });
    expect(policy.urlShare).toBe(LEVEL_FLOORS.hardened.urlShare);
  });

  it("applies a stricter override on a numeric ascending axis", () => {
    const policy = effectivePolicy("baseline", {
      mapTapSnapRadiusMeters: 75,
    });
    expect(policy.mapTapSnapRadiusMeters).toBe(75);
  });

  it("rejects a weaker numeric ascending override", () => {
    const policy = effectivePolicy("hardened", {
      mapTapSnapRadiusMeters: 10,
    });
    expect(policy.mapTapSnapRadiusMeters).toBe(
      LEVEL_FLOORS.hardened.mapTapSnapRadiusMeters,
    );
  });

  it("applies a stricter (lower) override on a numeric descending axis", () => {
    const policy = effectivePolicy("baseline", {
      m11TileCacheBudgetBytes: 1_000_000,
    });
    expect(policy.m11TileCacheBudgetBytes).toBe(1_000_000);
  });

  it("rejects a weaker (higher) numeric descending override", () => {
    const policy = effectivePolicy("strict", {
      m11TileCacheBudgetBytes: 999_999_999,
    });
    expect(policy.m11TileCacheBudgetBytes).toBe(
      LEVEL_FLOORS.strict.m11TileCacheBudgetBytes,
    );
  });

  it("only affects the specified axis (other axes match the floor)", () => {
    const overrides: Partial<PrivacyPolicy> = { errorReporting: false };
    const policy = effectivePolicy("baseline", overrides);
    const floor = LEVEL_FLOORS.baseline;
    expect(policy.errorReporting).toBe(false);
    for (const key of Object.keys(floor) as (keyof PrivacyPolicy)[]) {
      if (key === "errorReporting") continue;
      expect(policy[key]).toBe(floor[key]);
    }
  });

  it("ignores override values that are not in the strictness order list", () => {
    // @ts-expect-error - intentional invalid value to verify defensive handling.
    const policy = effectivePolicy("baseline", { urlShare: "bogus" });
    expect(policy.urlShare).toBe(LEVEL_FLOORS.baseline.urlShare);
  });
});

describe("stricterValue", () => {
  it("returns the higher-strictness enum value", () => {
    expect(stricterValue("urlShare", "coords-raw", "coords-stripped")).toBe(
      "coords-stripped",
    );
    expect(stricterValue("urlShare", "disabled", "coords-rounded")).toBe(
      "disabled",
    );
  });

  it("treats true as weaker than false on errorReporting (false = stricter)", () => {
    expect(stricterValue("errorReporting", true, false)).toBe(false);
  });

  it("picks the higher number for numeric ascending axes", () => {
    expect(stricterValue("m10CoarsenGridFloorMeters", 50, 25)).toBe(50);
  });

  it("picks the lower number for numeric descending axes", () => {
    expect(stricterValue("m11TileCacheBudgetBytes", 50, 25)).toBe(25);
  });
});

describe("LEVEL_FLOORS", () => {
  it("defines a floor for every PrivacyLevel", () => {
    for (const level of PRIVACY_LEVELS) {
      expect(LEVEL_FLOORS[level]).toBeDefined();
    }
  });

  it("every adjacent level pair differs in >= 2 axes", () => {
    const levels = PRIVACY_LEVELS;
    for (let i = 0; i < levels.length - 1; i++) {
      const a = LEVEL_FLOORS[levels[i] as PrivacyLevel];
      const b = LEVEL_FLOORS[levels[i + 1] as PrivacyLevel];
      const diffs = (Object.keys(a) as (keyof PrivacyPolicy)[]).filter(
        (k) => a[k] !== b[k],
      );
      expect(diffs.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("each level pair (i+1) is at least as strict as level i on every axis", () => {
    const levels = PRIVACY_LEVELS;
    for (let i = 0; i < levels.length - 1; i++) {
      const lower = LEVEL_FLOORS[levels[i] as PrivacyLevel];
      const higher = LEVEL_FLOORS[levels[i + 1] as PrivacyLevel];
      for (const key of Object.keys(lower) as (keyof PrivacyPolicy)[]) {
        const stricter = stricterValue(key, lower[key], higher[key]);
        expect(stricter).toBe(higher[key]);
      }
    }
  });
});

describe("AXIS_STRICTNESS_ORDER", () => {
  it("declares an order for every axis in PrivacyPolicy", () => {
    // Protection axes plus the former network axes (still read to classify
    // older installations).
    const floorKeys = Object.keys({
      ...LEVEL_FLOORS.baseline,
      ...LEGACY_NETWORK_FLOORS_V1.baseline,
    }).sort();
    const orderKeys = Object.keys(AXIS_STRICTNESS_ORDER).sort();
    expect(orderKeys).toEqual(floorKeys);
  });

  it("includes every level-floor value in its enum order list", () => {
    for (const key of Object.keys(LEVEL_FLOORS.baseline) as (keyof PrivacyPolicy)[]) {
      const order = AXIS_STRICTNESS_ORDER[key];
      if (order.kind !== "enum") continue;
      for (const level of PRIVACY_LEVELS) {
        const value = LEVEL_FLOORS[level][key];
        expect(
          (order.values as readonly unknown[]).includes(value),
          `axis ${String(key)} missing value ${String(value)} from level ${level}`,
        ).toBe(true);
      }
    }
  });
});

describe("Privacy Center policy axes", () => {
  it("records the former floors for basemap and nearby-stop network access", () => {
    expect(PRIVACY_LEVELS.map((level) => LEGACY_NETWORK_FLOORS_V1[level].basemapMode)).toEqual([
      "external-detailed",
      "external-detailed",
      "local-only",
      "local-only",
      "local-only",
    ]);
    expect(
      PRIVACY_LEVELS.map((level) => LEGACY_NETWORK_FLOORS_V1[level].nearbyStopLookup),
    ).toEqual([
      "centroid-server",
      "centroid-server",
      "local-only",
      "local-only",
      "local-only",
    ]);
  });

  it("defines the approved viewport and stop-personalization floors", () => {
    expect(
      PRIVACY_LEVELS.map((level) => LEVEL_FLOORS[level].viewportPersistence),
    ).toEqual([
      "raw",
      "snap-centroid",
      "rounded-50m",
      "rounded-100m",
      "off",
    ]);
    expect(
      PRIVACY_LEVELS.map((level) => LEVEL_FLOORS[level].stopUsageRetention),
    ).toEqual(["30d", "30d", "7d", "off", "off"]);
  });

  it("keeps network axes out of the protection policy", () => {
    const policy = effectivePolicy("standard", {
      basemapMode: "local-only",
      nearbyStopLookup: "local-only",
    } as Partial<PrivacyPolicy>);
    expect(policy).not.toHaveProperty("basemapMode");
    expect(policy).not.toHaveProperty("nearbyStopLookup");
  });

  it("classifies older network overrides with the legacy ratchet", () => {
    expect(
      legacyEffectiveNetworkPolicy("standard", { basemapMode: "local-only" }).basemapMode,
    ).toBe("local-only");
    expect(
      legacyEffectiveNetworkPolicy("hardened", { nearbyStopLookup: "centroid-server" })
        .nearbyStopLookup,
    ).toBe("local-only");
  });
});

describe("poiResidency axis (POI residency ceiling)", () => {
  it("floors: user-choice at baseline/standard, local-only at hardened/strict/paranoid", () => {
    expect(LEGACY_NETWORK_FLOORS_V1.baseline.poiResidency).toBe("user-choice");
    expect(LEGACY_NETWORK_FLOORS_V1.standard.poiResidency).toBe("user-choice");
    expect(LEGACY_NETWORK_FLOORS_V1.hardened.poiResidency).toBe("local-only");
    expect(LEGACY_NETWORK_FLOORS_V1.strict.poiResidency).toBe("local-only");
    expect(LEGACY_NETWORK_FLOORS_V1.paranoid.poiResidency).toBe("local-only");
  });

  it("declares the strictness order user-choice < local-only (mirrors routingAdapter)", () => {
    const order = AXIS_STRICTNESS_ORDER.poiResidency;
    if (order.kind !== "enum") throw new Error("expected enum axis");
    expect(order.values).toEqual(["user-choice", "local-only"]);
  });
});

describe("recentsEncryption off value", () => {
  it("lists off as the strictest value", () => {
    const o = AXIS_STRICTNESS_ORDER.recentsEncryption;
    const vals = o.kind === "enum" ? o.values : [];
    expect(vals[vals.length - 1]).toBe("off");
  });
  it("off beats every other recents value", () => {
    for (const v of ["plaintext", "encrypted", "encrypted-30d", "encrypted-7d", "ram-only"] as const) {
      expect(stricterValue("recentsEncryption", "off", v)).toBe("off");
    }
  });
  it("an off override wins at any level", () => {
    expect(effectivePolicy("baseline", { recentsEncryption: "off" }).recentsEncryption).toBe("off");
  });
  it("no level floor is off (D4 — paranoid stays ram-only)", () => {
    expect(LEVEL_FLOORS.paranoid.recentsEncryption).toBe("ram-only");
    for (const lvl of Object.values(LEVEL_FLOORS)) expect(lvl.recentsEncryption).not.toBe("off");
  });
});
