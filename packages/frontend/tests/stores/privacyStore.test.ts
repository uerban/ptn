import { beforeEach, describe, expect, it } from "vitest";
import { LEVEL_FLOORS, effectivePolicy } from "@pt/shared";
import {
  getPolicy,
  usePrivacyStore,
} from "../../src/stores/privacyStore.ts";

beforeEach(() => {
  usePrivacyStore.getState().reset();
  globalThis.localStorage?.removeItem("ptn-privacy");
});

describe("usePrivacyStore", () => {
  it("defaults to standard level with no overrides", () => {
    const state = usePrivacyStore.getState();
    expect(state.level).toBe("standard");
    expect(state.overrides).toEqual({});
  });

  it("setLevel updates the level", () => {
    usePrivacyStore.getState().setLevel("hardened");
    expect(usePrivacyStore.getState().level).toBe("hardened");
  });

  it("setOverride records a stricter override on a single axis", () => {
    usePrivacyStore.getState().setOverride("urlShare", "disabled");
    expect(usePrivacyStore.getState().overrides.urlShare).toBe("disabled");
  });

  it("clearOverride removes a previously set override", () => {
    const store = usePrivacyStore.getState();
    store.setOverride("errorReporting", false);
    expect(usePrivacyStore.getState().overrides.errorReporting).toBe(false);
    usePrivacyStore.getState().clearOverride("errorReporting");
    expect(
      "errorReporting" in usePrivacyStore.getState().overrides,
    ).toBe(false);
  });

  it("clearOverride is a no-op when the axis was never overridden", () => {
    const before = usePrivacyStore.getState().overrides;
    usePrivacyStore.getState().clearOverride("urlShare");
    expect(usePrivacyStore.getState().overrides).toEqual(before);
  });
});

describe("getPolicy", () => {
  it("returns the level floor when no overrides are set", () => {
    usePrivacyStore.getState().setLevel("hardened");
    expect(getPolicy()).toEqual(LEVEL_FLOORS.hardened);
  });

  it("applies overrides via effectivePolicy semantics (stricter wins)", () => {
    usePrivacyStore.getState().setLevel("baseline");
    usePrivacyStore.getState().setOverride("urlShare", "coords-stripped");
    const policy = getPolicy();
    expect(policy.urlShare).toBe("coords-stripped");
  });

  it("rejects an override weaker than the current level floor", () => {
    usePrivacyStore.getState().setLevel("strict");
    usePrivacyStore.getState().setOverride("urlShare", "coords-raw");
    const policy = getPolicy();
    expect(policy.urlShare).toBe(LEVEL_FLOORS.strict.urlShare);
  });

  it("matches effectivePolicy(level, overrides) for arbitrary state", () => {
    usePrivacyStore.getState().setLevel("hardened");
    usePrivacyStore.getState().setOverride("m11TileCacheBudgetBytes", 1_000_000);
    usePrivacyStore.getState().setOverride("urlShare", "disabled");
    const { level, overrides } = usePrivacyStore.getState();
    expect(getPolicy()).toEqual(effectivePolicy(level, overrides));
  });

  it("holds no network axis: network use is decided per flow", () => {
    usePrivacyStore.getState().setLevel("baseline");
    const policy = getPolicy() as unknown as Record<string, unknown>;
    for (const axis of [
      "m9SelfHosted",
      "m10ThirdPartyEnabled",
      "routingAdapter",
      "poiResidency",
      "realTimePolling",
      "basemapMode",
      "nearbyStopLookup",
    ]) {
      expect(policy).not.toHaveProperty(axis);
    }
  });
});

describe("usePrivacyStore persistence", () => {
  it("merge sanitizes invalid persisted level + overrides", () => {
    globalThis.localStorage?.setItem(
      "ptn-privacy",
      JSON.stringify({
        state: {
          level: "not-a-real-level",
          overrides: { urlShare: "bogus-value", m11TileCacheBudgetBytes: -1 },
        },
        version: 0,
      }),
    );
    // Force rehydration.
    usePrivacyStore.persist.rehydrate();
    const state = usePrivacyStore.getState();
    // Invalid level falls back to current default.
    expect(state.level).toBe("standard");
    // Invalid override values are dropped.
    expect(state.overrides).toEqual({});
  });

  it("merge accepts valid persisted state", () => {
    globalThis.localStorage?.setItem(
      "ptn-privacy",
      JSON.stringify({
        state: {
          level: "hardened",
          overrides: { urlShare: "disabled" },
        },
        version: 0,
      }),
    );
    usePrivacyStore.persist.rehydrate();
    const state = usePrivacyStore.getState();
    expect(state.level).toBe("hardened");
    expect(state.overrides.urlShare).toBe("disabled");
  });

  it("drops former network-axis overrides on hydration", () => {
    globalThis.localStorage?.setItem(
      "ptn-privacy",
      JSON.stringify({
        state: {
          level: "standard",
          overrides: { basemapMode: "local-only", urlShare: "disabled" },
        },
        version: 0,
      }),
    );
    usePrivacyStore.persist.rehydrate();
    expect(usePrivacyStore.getState().overrides).toEqual({ urlShare: "disabled" });
  });

  it("loads an old payload without materializing new-axis overrides", () => {
    globalThis.localStorage?.setItem(
      "ptn-privacy",
      JSON.stringify({
        state: {
          level: "hardened",
          overrides: { urlShare: "disabled" },
        },
        version: 0,
      }),
    );
    usePrivacyStore.persist.rehydrate();

    const state = usePrivacyStore.getState();
    expect(state.overrides).toEqual({ urlShare: "disabled" });
    expect(getPolicy().viewportPersistence).toBe("rounded-50m");
    expect(getPolicy().stopUsageRetention).toBe("7d");
  });
});
