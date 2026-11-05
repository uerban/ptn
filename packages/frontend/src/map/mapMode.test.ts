import { describe, expect, test, beforeEach, vi, type Mock } from "vitest";
import {
  applyMapMode,
  basemapModeFor,
  effectiveMapMode,
  isDetailedMapLocked,
  maxLevelForDetailedMap,
} from "./mapMode.ts";

describe("basemapModeFor", () => {
  test("only the detailed mode implies the external basemap", () => {
    expect(basemapModeFor("detailed")).toBe("external-detailed");
    expect(basemapModeFor("micromap")).toBe("local-only");
    expect(basemapModeFor("gtfs-only")).toBe("local-only");
  });
});

describe("effectiveMapMode", () => {
  test("passes the mode through when policy allows the external basemap", () => {
    expect(effectiveMapMode("detailed", "external-detailed")).toBe("detailed");
    expect(effectiveMapMode("micromap", "external-detailed")).toBe("micromap");
    expect(effectiveMapMode("gtfs-only", "external-detailed")).toBe("gtfs-only");
  });

  test("demotes a detailed preference to the micromap under local-only policy", () => {
    expect(effectiveMapMode("detailed", "local-only")).toBe("micromap");
  });

  test("leaves an explicit gtfs-only choice alone under local-only policy", () => {
    expect(effectiveMapMode("gtfs-only", "local-only")).toBe("gtfs-only");
  });
});

describe("privacy floors", () => {
  test("hardened and above lock the external basemap", () => {
    expect(isDetailedMapLocked("baseline")).toBe(false);
    expect(isDetailedMapLocked("standard")).toBe(false);
    expect(isDetailedMapLocked("hardened")).toBe(true);
    expect(isDetailedMapLocked("strict")).toBe(true);
    expect(isDetailedMapLocked("paranoid")).toBe(true);
  });

  test("names standard as the strictest level still allowing the external map", () => {
    expect(maxLevelForDetailedMap()).toBe("standard");
  });
});

describe("applyMapMode", () => {
  type Deps = Parameters<typeof applyMapMode>[1];
  let setMapDetailMode: Mock<Deps["setMapDetailMode"]>;
  let setOverride: Mock<Deps["setOverride"]>;
  let clearOverride: Mock<Deps["clearOverride"]>;

  beforeEach(() => {
    setMapDetailMode = vi.fn();
    setOverride = vi.fn();
    clearOverride = vi.fn();
  });

  const deps = (level: "baseline" | "standard" | "hardened") => ({
    level,
    setMapDetailMode,
    setOverride,
    clearOverride,
  });

  test("writes the display setting and the axis override together", () => {
    applyMapMode("micromap", deps("standard"));
    expect(setMapDetailMode).toHaveBeenCalledWith("micromap");
    expect(setOverride).toHaveBeenCalledWith("basemapMode", "local-only");
    expect(clearOverride).not.toHaveBeenCalled();
  });

  test("clears the override instead of pinning it to the level floor", () => {
    // At standard the floor is already external-detailed, so choosing the
    // detailed map must leave NO override behind — otherwise a later level
    // change would find a stale pin.
    applyMapMode("detailed", deps("standard"));
    expect(clearOverride).toHaveBeenCalledWith("basemapMode");
    expect(setOverride).not.toHaveBeenCalled();
  });

  test("clears the override for a local mode when the floor is already local", () => {
    applyMapMode("gtfs-only", deps("hardened"));
    expect(setMapDetailMode).toHaveBeenCalledWith("gtfs-only");
    expect(clearOverride).toHaveBeenCalledWith("basemapMode");
    expect(setOverride).not.toHaveBeenCalled();
  });
});
