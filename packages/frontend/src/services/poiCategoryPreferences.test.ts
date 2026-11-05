import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { db, type PoiIndexRecord } from "../db/index.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { BundledGeocoderAdapter } from "./geocoder/BundledGeocoderAdapter.ts";
import { searchSuggestions, searchSuggestionsStream } from "./searchSuggestions.ts";

vi.mock("./errorReporter.ts", () => ({ reportError: vi.fn() }));

const row = (id: string, category: string, tier: "strict" | "loose"): PoiIndexRecord => ({
  id, cityId: "gdansk", name: `Campus ${id}`, category, tier,
  lat: 54.35, lon: 18.65, geoBucket: `${Math.floor(54.35 * 100)}_${Math.floor(18.65 * 100)}`, aliases: {}, source: "osm", rankBoost: 1,
});

beforeEach(async () => {
  await db.poiIndex.clear();
  await db.gtfsStops.clear();
  await db.stopGroups.clear();
  await db.poiIndex.bulkPut([
    row("museum", "culture", "strict"), row("school", "school", "loose"),
    row("nursery", "kindergarten", "loose"), row("store", "retail", "loose"),
  ]);
  useSettingsStore.getState().setPoiIncludeLooseTier(true);
});
afterEach(() => { useSettingsStore.getState().setPoiIncludeLooseTier(true); });

describe("cached POI category filtering", () => {
  it("changes forward and reverse results offline without deleting cached rows", async () => {
    const adapter = new BundledGeocoderAdapter(() => "tricity");
    const signal = new AbortController().signal;
    expect(await adapter.forward("Campus", null, signal)).toHaveLength(4);
    useSettingsStore.getState().setPoiLooseCategories(["kindergarten"]);
    expect((await adapter.forward("Campus", null, signal)).map((r) => r.label).sort())
      .toEqual(["Campus museum", "Campus nursery"]);
    useSettingsStore.getState().setPoiLooseCategories([]);
    expect((await adapter.forward("Campus", null, signal)).map((r) => r.label)).toEqual(["Campus museum"]);
    expect((await adapter.reverse({ lat: 54.35, lon: 18.65 }, signal))?.label).toBe("Campus museum");
    expect(await db.poiIndex.count()).toBe(4);
    useSettingsStore.getState().setPoiLooseCategories(["school"]);
    expect((await adapter.forward("Campus school", null, signal)).map((r) => r.label)).toEqual(["Campus school"]);
  });

  it("applies the selection to initial and progressive suggestions", async () => {
    useSettingsStore.getState().setPoiLooseCategories(["kindergarten"]);
    const signal = new AbortController().signal;
    const labels = (rows: Awaited<ReturnType<typeof searchSuggestions>>) => rows
      .filter((r) => r.kind === "geocoded").map((r) => r.label).sort();
    expect(labels(await searchSuggestions("Campus", "tricity", null, signal, "local")))
      .toEqual(["Campus museum", "Campus nursery"]);
    const emissions: string[][] = [];
    await searchSuggestionsStream("Campus", "tricity", null, signal, "local", {
      onResults: (rows) => { emissions.push(labels(rows)); },
      driver: async (onTileLanded) => {
        await onTileLanded([row("late-school", "school", "loose")]);
      },
    });
    expect(emissions.length).toBeGreaterThan(1);
    for (const emission of emissions) expect(emission).toEqual(["Campus museum", "Campus nursery"]);
  });
});
