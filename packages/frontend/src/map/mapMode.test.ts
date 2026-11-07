import { LEVEL_FLOORS } from "@pt/shared/privacy";
import { describe, expect, test, beforeEach, vi } from "vitest";
import { applyMapMode, effectiveMapMode, isDetailedMapLocked } from "./mapMode.ts";
import { canUse, getNetworkDecision } from "../privacy/canUse.ts";
import { getPolicy, usePrivacyStore } from "../stores/privacyStore.ts";
import { denyFlow, resetFlows } from "../test-helpers/networkDecisions.ts";

describe("effectiveMapMode", () => {
  test("passes the mode through when the detailed map is allowed", () => {
    expect(effectiveMapMode("detailed", true)).toBe("detailed");
    expect(effectiveMapMode("micromap", true)).toBe("micromap");
    expect(effectiveMapMode("gtfs-only", true)).toBe("gtfs-only");
  });

  test("demotes a detailed preference to the micromap while the provider is not allowed", () => {
    expect(effectiveMapMode("detailed", false)).toBe("micromap");
  });

  test("leaves an explicit gtfs-only choice alone", () => {
    expect(effectiveMapMode("gtfs-only", false)).toBe("gtfs-only");
  });
});

describe("isDetailedMapLocked", () => {
  test("locks only a provider the build does not ship, at any level", async () => {
    await usePrivacyStore.getState().setLevel("paranoid");
    expect(isDetailedMapLocked()).toBe(false);
    expect(isDetailedMapLocked("carto")).toBe(false);
    expect(isDetailedMapLocked("unknown")).toBe(true);
    usePrivacyStore.getState().reset();
  });
});

describe("applyMapMode", () => {
  beforeEach(() => {
    resetFlows();
    usePrivacyStore.getState().reset();
  });

  test("choosing the detailed map records the provider decision and the display setting", () => {
    const setMapDetailMode = vi.fn();
    applyMapMode("detailed", { setMapDetailMode });
    expect(setMapDetailMode).toHaveBeenCalledWith("detailed");
    expect(canUse("external.detailed-basemap", "carto")).toBe(true);
    expect(getNetworkDecision("external.detailed-basemap", "carto")).toMatchObject({
      value: "allowed",
      source: "settings",
    });
  });

  test("choosing a local mode only changes the display setting", () => {
    denyFlow("external.detailed-basemap", "carto");
    const setMapDetailMode = vi.fn();
    const grantDetailedMap = vi.fn();
    applyMapMode("micromap", { setMapDetailMode, grantDetailedMap });
    expect(setMapDetailMode).toHaveBeenCalledWith("micromap");
    expect(grantDetailedMap).not.toHaveBeenCalled();
    expect(getNetworkDecision("external.detailed-basemap", "carto").value).toBe("denied");
  });

  test("never touches the protection level or its overrides", () => {
    applyMapMode("detailed", { setMapDetailMode: vi.fn() });
    applyMapMode("gtfs-only", { setMapDetailMode: vi.fn() });
    expect(getPolicy()).toEqual(LEVEL_FLOORS.standard);
    expect(usePrivacyStore.getState().overrides).toEqual({});
  });
});
