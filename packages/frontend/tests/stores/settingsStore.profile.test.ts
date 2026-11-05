import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { VISION_IMPAIRED_WALK_SPEED_MPS, WHEELCHAIR_WALK_SPEED_MPS } from "@pt/shared";

// Note: the project's MobilityProfile uses "default" (not "standard")
// for the non-accessibility profile — see packages/shared/src/types/routing.ts.

describe("setMobilityProfile delegates to resolveWalkParams", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      walkSpeedMps: 1.4,
      mobilityProfile: "default",
    });
  });

  it("caps walkSpeedMps at the wheelchair speed when flipping to wheelchair from above-cap", () => {
    useSettingsStore.setState({ walkSpeedMps: 1.6 });
    useSettingsStore.getState().setMobilityProfile("wheelchair");
    expect(useSettingsStore.getState().walkSpeedMps).toBe(
      WHEELCHAIR_WALK_SPEED_MPS,
    );
  });

  it("preserves a below-cap walkSpeedMps when flipping to wheelchair", () => {
    useSettingsStore.setState({ walkSpeedMps: 0.5 });
    useSettingsStore.getState().setMobilityProfile("wheelchair");
    expect(useSettingsStore.getState().walkSpeedMps).toBe(0.5);
  });

  it("disables runToCatch on wheelchair profile", () => {
    useSettingsStore.setState({ runToCatch: true });
    useSettingsStore.getState().setMobilityProfile("wheelchair");
    expect(useSettingsStore.getState().runToCatch).toBe(false);
  });

  it("disables runToCatch on vision_impaired profile", () => {
    useSettingsStore.setState({ runToCatch: true });
    useSettingsStore.getState().setMobilityProfile("vision_impaired");
    expect(useSettingsStore.getState().runToCatch).toBe(false);
  });

  it("does NOT auto-restore walkSpeedMps when wheelchair → default flips back", () => {
    // Behaviour change vs. prior code (the deleted auto-restore branch in
    // setMobilityProfile would have overwritten walkSpeedMps to
    // DEFAULT_WALK_SPEED_MPS when leaving the wheelchair profile). The
    // resolver now passes the value through unchanged on default profile.
    // Pinned here so a future regression that re-introduces auto-restore
    // would fail loudly.
    useSettingsStore.setState({
      walkSpeedMps: 1.6,
      mobilityProfile: "default",
    });
    useSettingsStore.getState().setMobilityProfile("wheelchair");
    expect(useSettingsStore.getState().walkSpeedMps).toBe(
      WHEELCHAIR_WALK_SPEED_MPS,
    );
    useSettingsStore.getState().setMobilityProfile("default");
    // Capped value preserved — neither auto-restored to 1.4 nor returned
    // to the original 1.6.
    expect(useSettingsStore.getState().walkSpeedMps).toBe(
      WHEELCHAIR_WALK_SPEED_MPS,
    );
  });
});

describe("setWalkSpeedMps enforces wheelchair cap", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      walkSpeedMps: WHEELCHAIR_WALK_SPEED_MPS,
      mobilityProfile: "wheelchair",
    });
  });

  it("caps an above-cap setter call when wheelchair profile is active", () => {
    // Direct setter bypassing the slider's onChange short-circuit (e.g. from
    // a future component, e2e harness, dev-tools, or a persisted-state
    // migration) must NOT leave the store with a wheelchair profile +
    // above-cap speed. Resolver-in-setter is the architectural enforcement.
    useSettingsStore.getState().setWalkSpeedMps(2.5);
    expect(useSettingsStore.getState().walkSpeedMps).toBe(
      WHEELCHAIR_WALK_SPEED_MPS,
    );
  });

  it("honors a below-cap setter call when wheelchair profile is active", () => {
    useSettingsStore.getState().setWalkSpeedMps(0.5);
    expect(useSettingsStore.getState().walkSpeedMps).toBe(0.5);
  });

  it("passes through values normally on the default profile", () => {
    useSettingsStore.setState({ mobilityProfile: "default" });
    useSettingsStore.getState().setWalkSpeedMps(2.0);
    expect(useSettingsStore.getState().walkSpeedMps).toBe(2.0);
  });
});

describe("vision-impaired walking speed", () => {
  beforeEach(() => {
    useSettingsStore.setState({ walkSpeedMps: 1.25, mobilityProfile: "default" });
  });

  it("starts at 3.5 km/h when the rider switches to vision impaired", () => {
    useSettingsStore.getState().setMobilityProfile("vision_impaired");
    expect(useSettingsStore.getState().walkSpeedMps).toBe(VISION_IMPAIRED_WALK_SPEED_MPS);
  });

  it("keeps a slower speed on the switch", () => {
    useSettingsStore.setState({ walkSpeedMps: 0.75 });
    useSettingsStore.getState().setMobilityProfile("vision_impaired");
    expect(useSettingsStore.getState().walkSpeedMps).toBe(0.75);
  });

  it("is a start, not a cap: the rider can raise the speed afterwards", () => {
    useSettingsStore.getState().setMobilityProfile("vision_impaired");
    useSettingsStore.getState().setWalkSpeedMps(1.5);
    expect(useSettingsStore.getState().walkSpeedMps).toBe(1.5);
  });

  it("re-choosing vision impaired keeps a raised speed", () => {
    useSettingsStore.getState().setMobilityProfile("vision_impaired");
    useSettingsStore.getState().setWalkSpeedMps(1.5);
    useSettingsStore.getState().setMobilityProfile("vision_impaired");
    expect(useSettingsStore.getState().walkSpeedMps).toBe(1.5);
  });
});
