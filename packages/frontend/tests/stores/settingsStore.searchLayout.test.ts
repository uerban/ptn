import { beforeEach, describe, expect, it, vi } from "vitest";

const choices = [
  ["searchActiveFieldOnly", "setSearchActiveFieldOnly"],
  ["searchKeyboardFit", "setSearchKeyboardFit"],
  ["searchCompactRows", "setSearchCompactRows"],
  ["searchDismissOnScroll", "setSearchDismissOnScroll"],
] as const;

beforeEach(() => { localStorage.clear(); vi.resetModules(); });
describe("temporary search layout preferences", () => {
  it("enables exactly the four agreed choices by default", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
    for (const [key] of choices) expect(useSettingsStore.getState()[key]).toBe(true);
  });
  it("persists alternatives and restores them on reload", async () => {
    const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
    for (const [, setter] of choices) useSettingsStore.getState()[setter](false);
    vi.resetModules();
    const restored = await import("../../src/stores/settingsStore.ts");
    for (const [key] of choices) expect(restored.useSettingsStore.getState()[key]).toBe(false);
  });
  it("falls back to defaults for corrupt values and old settings", async () => {
    localStorage.setItem("ptn-settings", JSON.stringify({ state: {
      searchActiveFieldOnly: "false", searchKeyboardFit: null, searchCompactRows: 0,
    }, version: 0 }));
    const { useSettingsStore } = await import("../../src/stores/settingsStore.ts");
    for (const [key] of choices) expect(useSettingsStore.getState()[key]).toBe(true);
  });
});
