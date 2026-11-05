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

  it("rejects an invalid persisted mode", async () => {
    localStorage.setItem("ptn-settings", JSON.stringify({ state: { gpsMode: "maybe" }, version: 0 }));
    const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
    expect(useSettingsStore.getState().gpsMode).toBe("enabled");
  });
});
