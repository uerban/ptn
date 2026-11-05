import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type * as maplibregl from "maplibre-gl";

const loadMicromap = vi.fn();
vi.mock("../../services/micromapLoader.ts", () => ({
  loadMicromap: (...args: unknown[]) => loadMicromap(...args),
  micromapUrl: (cityId: string) => `/micromap/${cityId}.micromap.br`,
}));

vi.mock("../../stores/cityStore.ts", () => ({
  useCityStore: (selector: (s: unknown) => unknown) =>
    selector({ activeCity: { id: "vilnius" } }),
}));

import { MicromapLayer, MICROMAP_LAYERS, MICROMAP_SOURCES } from "./MicromapLayer.tsx";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { usePrivacyStore } from "../../stores/privacyStore.ts";

const SQUARE = "_rzlI_{xxC?o}@o}@??n}@n}@?";

const ARTIFACT = {
  version: 1 as const,
  cityId: "vilnius",
  generatedAt: "2026-08-20",
  attribution: "© OpenStreetMap contributors (ODbL)",
  bbox: [25.15, 54.62, 25.42, 54.75] as [number, number, number, number],
  water: [{ r: [SQUARE] }],
  green: [],
  waterways: [{ c: "river", g: "_rzlI_{xxC?o}@" }],
  roads: [{ c: "primary", g: "_rzlI_{xxC?o}@" }],
  places: [{ n: "Antakalnis", y: 54.7, x: 25.3, r: 3 }],
};

/** Minimal fake MapLibre map — layer stacking is real so anchoring is testable. */
function createFakeMap(
  { glyphs }: { glyphs?: string | null } = {},
) {
  const glyphsUrl = glyphs === undefined ? "/glyphs/{fontstack}/{range}.pbf" : glyphs;
  const layers: { id: string }[] = [{ id: "stops-clusters" }];
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const handlers: { event: string; fn: () => void }[] = [];
  const layerIdx = (id: string) => layers.findIndex((l) => l.id === id);

  return {
    addSource: vi.fn((id: string) => {
      sources.set(id, { setData: vi.fn() });
    }),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    getSource: vi.fn((id: string) => sources.get(id)),
    addLayer: vi.fn((def: { id: string }, beforeId?: string) => {
      const i = beforeId === undefined ? -1 : layerIdx(beforeId);
      if (i >= 0) layers.splice(i, 0, def);
      else layers.push(def);
    }),
    removeLayer: vi.fn((id: string) => {
      const i = layerIdx(id);
      if (i >= 0) layers.splice(i, 1);
    }),
    moveLayer: vi.fn((id: string, beforeId?: string) => {
      const from = layerIdx(id);
      if (from < 0) return;
      const [def] = layers.splice(from, 1);
      const to = beforeId === undefined ? -1 : layerIdx(beforeId);
      if (to >= 0) layers.splice(to, 0, def);
      else layers.push(def);
    }),
    getLayer: vi.fn((id: string) => layers.find((l) => l.id === id)),
    getStyle: vi.fn(() => ({ layers: [...layers], glyphs: glyphsUrl })),
    isStyleLoaded: vi.fn(() => true),
    setPaintProperty: vi.fn(),
    on: vi.fn((event: string, fn: () => void) => {
      handlers.push({ event, fn });
    }),
    off: vi.fn((event: string, fn: () => void) => {
      const i = handlers.findIndex((h) => h.event === event && h.fn === fn);
      if (i >= 0) handlers.splice(i, 1);
    }),
    hasLayer: (id: string) => layerIdx(id) >= 0,
    hasSource: (id: string) => sources.has(id),
    layerOrder: () => layers.map((l) => l.id),
  };
}

type FakeMap = ReturnType<typeof createFakeMap>;

async function renderLayer(map: FakeMap) {
  const view = render(
    <MicromapLayer map={map as unknown as maplibregl.Map} />,
  );
  // Let the artifact promise resolve into state.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

beforeEach(() => {
  loadMicromap.mockReset();
  loadMicromap.mockResolvedValue(ARTIFACT);
  usePrivacyStore.getState().reset();
  useSettingsStore.getState().setMapDetailMode("micromap");
  useSettingsStore.setState({ resolvedTheme: "light" });
});

afterEach(() => cleanup());

describe("MicromapLayer", () => {
  test("draws every family below the transit layers", async () => {
    const map = createFakeMap();
    await renderLayer(map);

    for (const source of Object.values(MICROMAP_SOURCES)) {
      expect(map.hasSource(source)).toBe(true);
    }
    for (const layer of Object.values(MICROMAP_LAYERS)) {
      expect(map.hasLayer(layer)).toBe(true);
    }
    const order = map.layerOrder();
    expect(order[order.length - 1]).toBe("stops-clusters");
  });

  test("stays off when the map mode is not micromap", async () => {
    useSettingsStore.getState().setMapDetailMode("gtfs-only");
    const map = createFakeMap();
    await renderLayer(map);

    expect(loadMicromap).not.toHaveBeenCalled();
    expect(map.hasLayer(MICROMAP_LAYERS.roads)).toBe(false);
  });

  test("runs when policy demotes a detailed preference to local-only", async () => {
    useSettingsStore.getState().setMapDetailMode("detailed");
    usePrivacyStore.getState().setLevel("hardened");
    const map = createFakeMap();
    await renderLayer(map);

    expect(loadMicromap).toHaveBeenCalledWith("vilnius");
    expect(map.hasLayer(MICROMAP_LAYERS.roads)).toBe(true);
  });

  test("draws nothing for a city without an artifact", async () => {
    loadMicromap.mockResolvedValue(null);
    const map = createFakeMap();
    await renderLayer(map);

    expect(map.hasLayer(MICROMAP_LAYERS.areas)).toBe(false);
    expect(map.hasSource(MICROMAP_SOURCES.areas)).toBe(false);
  });

  test("skips the label layer when the style ships no glyphs", async () => {
    const map = createFakeMap({ glyphs: null });
    await renderLayer(map);

    expect(map.hasLayer(MICROMAP_LAYERS.roads)).toBe(true);
    expect(map.hasLayer(MICROMAP_LAYERS.places)).toBe(false);
  });

  test("repaints instead of re-adding layers on a theme flip", async () => {
    const map = createFakeMap();
    await renderLayer(map);
    const addedBefore = map.addLayer.mock.calls.length;

    await act(async () => {
      useSettingsStore.setState({ resolvedTheme: "dark" });
      await Promise.resolve();
    });

    expect(map.addLayer.mock.calls.length).toBe(addedBefore);
    expect(map.setPaintProperty).toHaveBeenCalledWith(
      MICROMAP_LAYERS.roads,
      "line-color",
      expect.any(String),
    );
  });

  test("tears the micromap down when the user switches to the detailed map", async () => {
    const map = createFakeMap();
    const { rerender } = await renderLayer(map);

    await act(async () => {
      useSettingsStore.getState().setMapDetailMode("detailed");
      await Promise.resolve();
    });
    rerender(<MicromapLayer map={map as unknown as maplibregl.Map} />);

    for (const layer of Object.values(MICROMAP_LAYERS)) {
      expect(map.hasLayer(layer)).toBe(false);
    }
  });
});
