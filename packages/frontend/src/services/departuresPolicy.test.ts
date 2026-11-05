import { describe, it, expect, beforeEach } from "vitest";
import { backendDeparturesAllowed, liveTileOverlayAllowed } from "./departuresPolicy.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";

describe("backendDeparturesAllowed", () => {
  beforeEach(() => usePrivacyStore.getState().reset()); // default level "standard"

  it("permits at baseline (backend-adaptive)", async () => {
    await usePrivacyStore.getState().setLevel("baseline");
    expect(backendDeparturesAllowed()).toBe(true);
  });
  it("permits at standard (backend-adaptive)", () => {
    expect(backendDeparturesAllowed()).toBe(true);
  });
  it("permits at hardened (backend-foreground-only)", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    expect(backendDeparturesAllowed()).toBe(true);
  });
  it("forbids at strict (disabled-schedule-only)", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    expect(backendDeparturesAllowed()).toBe(false);
  });
  it("forbids at paranoid (disabled-schedule-only)", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    expect(backendDeparturesAllowed()).toBe(false);
  });
  it("honors an override-ratchet tightening at a permissive level", () => {
    usePrivacyStore.getState().setOverride("realTimePolling", "disabled-schedule-only");
    expect(backendDeparturesAllowed()).toBe(false);
  });
});

describe("liveTileOverlayAllowed", () => {
  beforeEach(() => usePrivacyStore.getState().reset()); // default level "standard"

  it("permits at standard (backend-adaptive)", () => {
    expect(liveTileOverlayAllowed()).toBe(true);
  });
  it("permits at hardened (backend-foreground-only)", async () => {
    await usePrivacyStore.getState().setLevel("hardened");
    expect(liveTileOverlayAllowed()).toBe(true);
  });
  it("forbids at strict (disabled-schedule-only)", async () => {
    await usePrivacyStore.getState().setLevel("strict");
    expect(liveTileOverlayAllowed()).toBe(false);
  });
  it("honors an override-ratchet tightening at a permissive level", () => {
    usePrivacyStore.getState().setOverride("realTimePolling", "disabled-schedule-only");
    expect(liveTileOverlayAllowed()).toBe(false);
  });
});
