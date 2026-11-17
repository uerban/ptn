import { beforeEach, describe, expect, it, vi } from "vitest";

describe("GPS mode persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults existing installations to foreground tracking", async () => {
    localStorage.setItem("ptn-settings", JSON.stringify({ state: { startupLocate: false }, version: 0 }));
    const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
    expect(useSettingsStore.getState().gpsMode).toBe("enabled");
  });

  it.each(["enabled", "until-locate", "disabled"] as const)("round-trips %s across reload", async (mode) => {
    const first = await import("../../src/stores/settingsStore.ts");
    first.useSettingsStore.getState().setGpsMode(mode);
    vi.resetModules();
    const second = await import("../../src/stores/settingsStore.ts");
    expect(second.useSettingsStore.getState().gpsMode).toBe(mode);
  });

  it("keeps a remembered grant across reload, only with GPS on", async () => {
    const first = await import("../../src/stores/settingsStore.ts");
    expect(first.useSettingsStore.getState().gpsGranted).toBe(false);
    first.useSettingsStore.getState().setGpsGranted(true);
    vi.resetModules();
    const second = await import("../../src/stores/settingsStore.ts");
    expect(second.useSettingsStore.getState().gpsGranted).toBe(true);
    localStorage.setItem("ptn-settings", JSON.stringify({ state: { gpsMode: "disabled", gpsGranted: true }, version: 0 }));
    vi.resetModules();
    const third = await import("../../src/stores/settingsStore.ts");
    expect(third.useSettingsStore.getState().gpsGranted).toBe(false);
  });

  it("rejects an invalid persisted mode", async () => {
    localStorage.setItem("ptn-settings", JSON.stringify({ state: { gpsMode: "maybe" }, version: 0 }));
    const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
    expect(useSettingsStore.getState().gpsMode).toBe("enabled");
  });
});
