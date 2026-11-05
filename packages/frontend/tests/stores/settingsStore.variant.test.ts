import { describe, it, expect, beforeEach, vi } from "vitest";

describe("data-variant propagation", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-variant");
    vi.resetModules();
  });

  it("applies `consumer` on default first paint", async () => {
    await import("../../src/stores/settingsStore.ts");
    expect(document.documentElement.getAttribute("data-variant")).toBe("consumer");
  });

  it("updates attribute when setRouteSearchVariant is called", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    mod.useSettingsStore.getState().setRouteSearchVariant("power");
    expect(document.documentElement.getAttribute("data-variant")).toBe("power");
  });

  it("auto-upgrades to accessible when mobility is vision_impaired, preserving stored variant", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    mod.useSettingsStore.getState().setRouteSearchVariant("power");
    mod.useSettingsStore.getState().setMobilityProfile("vision_impaired");
    expect(document.documentElement.getAttribute("data-variant")).toBe("accessible");
    expect(mod.useSettingsStore.getState().routeSearchVariant).toBe("power");
  });

  it("restores explicit variant when mobility returns to default", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    mod.useSettingsStore.getState().setRouteSearchVariant("power");
    mod.useSettingsStore.getState().setMobilityProfile("vision_impaired");
    mod.useSettingsStore.getState().setMobilityProfile("default");
    expect(document.documentElement.getAttribute("data-variant")).toBe("power");
  });

  it("recovers to consumer when persisted JSON is corrupt", async () => {
    localStorage.setItem("ptn-settings", "{{ not valid json");
    await import("../../src/stores/settingsStore.ts");
    expect(document.documentElement.getAttribute("data-variant")).toBe("consumer");
  });
});

describe("setRouteSearchVariant rejects bogus values", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("leaves stored variant unchanged when given a non-member string", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    mod.useSettingsStore.getState().setRouteSearchVariant("consumer");
    // @ts-expect-error — deliberately passing a bogus runtime value
    mod.useSettingsStore.getState().setRouteSearchVariant("bogus");
    expect(mod.useSettingsStore.getState().routeSearchVariant).toBe("consumer");
  });
});
