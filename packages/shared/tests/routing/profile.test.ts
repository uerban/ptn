import { describe, it, expect } from "vitest";
import {
  MIN_TRANSFER_SECS_BY_PROFILE,
  minTransferSecsFor,
  resolveWalkParams,
  resolveWalkParamsOnSwitch,
  riderWalkSpeedMps,
  VISION_IMPAIRED_WALK_SPEED_MPS,
  WHEELCHAIR_WALK_SPEED_MPS,
  DEFAULT_WALK_SPEED_MPS,
  DEFAULT_MAX_WALK_SECS,
  MAX_RUN_SPEED_MPS,
  runSpeedMps,
} from "../../src/routing/profile.ts";

// Note: the project's MobilityProfile uses "default" (not "standard")
// for the non-accessibility profile — see packages/shared/src/types/routing.ts.

describe("resolveWalkParams", () => {
  it("caps walkSpeedMps at the wheelchair speed when profile=wheelchair", () => {
    const out = resolveWalkParams("wheelchair", {
      walkSpeedMps: 1.6,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(WHEELCHAIR_WALK_SPEED_MPS);
    expect(out.maxWalkSecs).toBe(1200);
  });

  it("honors a slower-than-cap walkSpeedMps on the wheelchair profile", () => {
    const out = resolveWalkParams("wheelchair", {
      walkSpeedMps: 0.5,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(0.5);
  });

  it("passes through walkSpeedMps unchanged on the default profile", () => {
    const out = resolveWalkParams("default", {
      walkSpeedMps: 1.6,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(1.6);
    expect(out.maxWalkSecs).toBe(1200);
  });

  it("uses the default walk speed when settings has no walkSpeedMps", () => {
    const out = resolveWalkParams("default", {
      walkSpeedMps: undefined,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(DEFAULT_WALK_SPEED_MPS);
  });

  it("uses the default max-walk-secs when settings has no maxWalkSecs", () => {
    const out = resolveWalkParams("default", {
      walkSpeedMps: 1.4,
      maxWalkSecs: undefined,
    });
    expect(out.maxWalkSecs).toBe(DEFAULT_MAX_WALK_SECS);
  });

  it("vision_impaired profile passes through the user's walkSpeedMps unchanged (no cap)", () => {
    const out = resolveWalkParams("vision_impaired", {
      walkSpeedMps: 1.0,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(1.0);
  });

  // Without these guards, `Math.min(NaN, cap)` returns NaN, which propagates
  // into RAPTOR walk-time arithmetic and silently produces "no routes found"
  // with no diagnostic. Same risk with negative or zero speed.
  it("falls back to default when walkSpeedMps is NaN", () => {
    const out = resolveWalkParams("default", {
      walkSpeedMps: NaN,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(DEFAULT_WALK_SPEED_MPS);
  });

  it("falls back to default when walkSpeedMps is Infinity", () => {
    const out = resolveWalkParams("default", {
      walkSpeedMps: Infinity,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(DEFAULT_WALK_SPEED_MPS);
  });

  it("falls back to default when walkSpeedMps is zero or negative", () => {
    expect(
      resolveWalkParams("default", { walkSpeedMps: 0, maxWalkSecs: 1200 })
        .walkSpeedMps,
    ).toBe(DEFAULT_WALK_SPEED_MPS);
    expect(
      resolveWalkParams("default", { walkSpeedMps: -1, maxWalkSecs: 1200 })
        .walkSpeedMps,
    ).toBe(DEFAULT_WALK_SPEED_MPS);
  });

  it("falls back to default when maxWalkSecs is NaN/Infinity/non-positive", () => {
    expect(
      resolveWalkParams("default", { walkSpeedMps: 1.4, maxWalkSecs: NaN })
        .maxWalkSecs,
    ).toBe(DEFAULT_MAX_WALK_SECS);
    expect(
      resolveWalkParams("default", {
        walkSpeedMps: 1.4,
        maxWalkSecs: Infinity,
      }).maxWalkSecs,
    ).toBe(DEFAULT_MAX_WALK_SECS);
    expect(
      resolveWalkParams("default", { walkSpeedMps: 1.4, maxWalkSecs: 0 })
        .maxWalkSecs,
    ).toBe(DEFAULT_MAX_WALK_SECS);
  });

  it("does not auto-restore walkSpeedMps to default when wheelchair → default flips back", () => {
    // Behaviour change vs. prior code: the deleted auto-restore branch in
    // settingsStore.setMobilityProfile used to overwrite walkSpeedMps to
    // DEFAULT_WALK_SPEED_MPS when leaving the wheelchair profile. The
    // resolver now passes the value through unchanged on default — a
    // user who customised below the cap keeps their setting. This test
    // pins the new contract so a future regression that re-introduces
    // auto-restore would fail loudly.
    const out = resolveWalkParams("default", {
      walkSpeedMps: 0.5,
      maxWalkSecs: 1200,
    });
    expect(out.walkSpeedMps).toBe(0.5); // preserved, NOT bumped to default
  });
});

describe("runSpeedMps", () => {
  it("doubles the rider's own walking speed", () => {
    expect(runSpeedMps(1.25)).toBe(2.5);
  });

  it("caps a fast walker at a jog, not a sprint", () => {
    expect(runSpeedMps(1.6)).toBe(MAX_RUN_SPEED_MPS);
  });
});

describe("resolveWalkParamsOnSwitch", () => {
  it("starts the vision-impaired profile at 3.5 km/h from a faster speed", () => {
    const out = resolveWalkParamsOnSwitch("vision_impaired", { walkSpeedMps: DEFAULT_WALK_SPEED_MPS, maxWalkSecs: 1200 });
    expect(out.walkSpeedMps).toBe(VISION_IMPAIRED_WALK_SPEED_MPS);
    expect(out.walkSpeedMps * 3.6).toBeCloseTo(3.5, 10);
    expect(out.maxWalkSecs).toBe(1200);
  });

  it("keeps a slower speed when switching to vision impaired", () => {
    const out = resolveWalkParamsOnSwitch("vision_impaired", { walkSpeedMps: 0.6, maxWalkSecs: 1200 });
    expect(out.walkSpeedMps).toBe(0.6);
  });

  it("starts vision impaired at 3.5 km/h when settings has no speed", () => {
    const out = resolveWalkParamsOnSwitch("vision_impaired", { walkSpeedMps: undefined, maxWalkSecs: undefined });
    expect(out.walkSpeedMps).toBe(VISION_IMPAIRED_WALK_SPEED_MPS);
    expect(out.maxWalkSecs).toBe(DEFAULT_MAX_WALK_SECS);
  });

  it("matches resolveWalkParams for the other profiles", () => {
    for (const profile of ["default", "wheelchair", "bicycle"] as const) {
      const input = { walkSpeedMps: 1.6, maxWalkSecs: 900 };
      expect(resolveWalkParamsOnSwitch(profile, input)).toEqual(resolveWalkParams(profile, input));
    }
  });
});

describe("riderWalkSpeedMps", () => {
  it("walks a wheelchair rider at the wheelchair speed and others at their own", () => {
    expect(riderWalkSpeedMps("wheelchair", 0.5)).toBe(WHEELCHAIR_WALK_SPEED_MPS);
    expect(riderWalkSpeedMps("default", 1.6)).toBe(1.6);
    expect(riderWalkSpeedMps("vision_impaired", VISION_IMPAIRED_WALK_SPEED_MPS)).toBe(VISION_IMPAIRED_WALK_SPEED_MPS);
    expect(riderWalkSpeedMps(undefined, 1.1)).toBe(1.1);
  });
});

describe("minTransferSecsFor", () => {
  it("keeps every profile at the engine default of 120 s for now", () => {
    for (const profile of ["default", "wheelchair", "vision_impaired", "bicycle"] as const) {
      expect(minTransferSecsFor(profile)).toBe(120);
    }
    expect(minTransferSecsFor(undefined)).toBe(120);
    expect(Object.keys(MIN_TRANSFER_SECS_BY_PROFILE).sort()).toEqual(["bicycle", "default", "vision_impaired", "wheelchair"]);
  });
});
