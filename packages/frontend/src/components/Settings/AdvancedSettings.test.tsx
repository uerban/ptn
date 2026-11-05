import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AdvancedSettings } from "./AdvancedSettings.tsx";
import { useSettingsStore } from "../../stores/settingsStore.ts";

beforeEach(() => { useSettingsStore.getState().setPoiIncludeLooseTier(true); });
afterEach(() => { cleanup(); useSettingsStore.getState().setPoiIncludeLooseTier(true); });

describe("additional POI categories", () => {
  it("lets users hide schools independently of kindergartens and supermarkets", () => {
    render(<AdvancedSettings />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    fireEvent.click(screen.getByRole("checkbox", { name: "Schools" }));
    expect((screen.getByRole("checkbox", { name: "Schools" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Kindergartens" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Supermarkets" }) as HTMLInputElement).checked).toBe(true);
    expect(useSettingsStore.getState().poiLooseCategories).toEqual(["kindergarten", "retail", "tourism", "named_bus_stop"]);
  });

  it("allows disabling all additional categories", () => {
    render(<AdvancedSettings />);
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(useSettingsStore.getState().poiLooseCategories).toEqual([]);
    expect(useSettingsStore.getState().poiIncludeLooseTier).toBe(false);
  });
});
