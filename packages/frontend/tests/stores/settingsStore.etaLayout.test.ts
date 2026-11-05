import { describe, it, expect, beforeEach, vi } from "vitest";

function storeWith(state: Record<string, unknown>) {
  localStorage.setItem("ptn-settings", JSON.stringify({ state, version: 0 }));
}

describe("etaCardsLayout persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults to `rows` on first load", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("rows");
  });

  it("keeps a stored `columns`", async () => {
    storeWith({ etaCardsLayout: "columns" });
    const mod = await import("../../src/stores/settingsStore.ts");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("columns");
  });

  it("coerces a stored unknown string to `rows`", async () => {
    storeWith({ etaCardsLayout: "grid" });
    const mod = await import("../../src/stores/settingsStore.ts");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("rows");
  });

  it("coerces a stored non-string to `rows`", async () => {
    storeWith({ etaCardsLayout: 42 });
    const mod = await import("../../src/stores/settingsStore.ts");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("rows");
  });

  it("recovers to `rows` when persisted JSON is corrupt", async () => {
    localStorage.setItem("ptn-settings", "{{ not valid json");
    const mod = await import("../../src/stores/settingsStore.ts");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("rows");
  });
});

describe("setEtaCardsLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("switches between the two layouts", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    mod.useSettingsStore.getState().setEtaCardsLayout("columns");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("columns");
    mod.useSettingsStore.getState().setEtaCardsLayout("rows");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("rows");
  });

  it("leaves the layout unchanged when given a non-member string", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    mod.useSettingsStore.getState().setEtaCardsLayout("columns");
    // @ts-expect-error — deliberately passing a bogus runtime value
    mod.useSettingsStore.getState().setEtaCardsLayout("grid");
    expect(mod.useSettingsStore.getState().etaCardsLayout).toBe("columns");
  });

  it("isEtaCardsLayout guards the union", async () => {
    const mod = await import("../../src/stores/settingsStore.ts");
    expect(mod.ETA_CARDS_LAYOUTS).toEqual(["rows", "columns"]);
    expect(mod.isEtaCardsLayout("rows")).toBe(true);
    expect(mod.isEtaCardsLayout("columns")).toBe(true);
    expect(mod.isEtaCardsLayout("grid")).toBe(false);
    expect(mod.isEtaCardsLayout(undefined)).toBe(false);
  });
});
