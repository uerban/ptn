import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type * as maplibregl from "maplibre-gl";
import type { GbfsStation } from "../../services/gbfs/types.ts";

// bikeShareStore pulls the GBFS client and Dexie helpers in at module load;
// the layer only reads store state, so both are mocked away.
vi.mock("../../db/index.ts", async () =>
  (await import("../../test-helpers/bikeShareFixtures.ts")).stubGbfsDb(),
);

import { BikeShareLayer, findBeforeId, reanchorAboveBasemap } from "./BikeShareLayer.tsx";
import {
  BIKE_CIRCLE_LAYER,
  BIKE_LABEL_COLOR,
  BIKE_LABEL_LAYER,
  BIKE_SOURCE,
} from "./bikeShareFeatures.ts";
import { useBikeShareStore } from "../../stores/bikeShareStore.ts";

const initialBikeShareState = useBikeShareStore.getState();

function makeStation(id: string, bikes: number | null = 5): GbfsStation {
  return {
    stationId: id,
    name: `Station ${id}`,
    lat: 54.68,
    lon: 25.28,
    bikesAvailable: bikes,
    docksAvailable: bikes === null ? null : 10,
    isInstalled: true,
    isRenting: bikes !== null,
    isReturning: bikes !== null,
    lastReported: bikes === null ? null : 1_752_000_000,
  };
}

interface RegisteredHandler {
  event: string;
  layerId: string | undefined;
  fn: (e: unknown) => void;
}

/**
 * Minimal fake MapLibre map: enough surface for BikeShareLayer plus a
 * `fire()` that dispatches to handlers in REGISTRATION order — the ordering
 * MapLibre guarantees and Home.tsx's tap pipeline relies on. Layers keep
 * real style order (`beforeId` inserts, `moveLayer` repositions) so the
 * anchor / re-anchor logic can be tested against actual layer stacking.
 */
function createFakeMap() {
  const layers: { id: string; source?: string }[] = [];
  const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  const handlers: RegisteredHandler[] = [];
  const canvas = { style: { cursor: "" } } as unknown as HTMLCanvasElement;
  const layerIdx = (id: string) => layers.findIndex((l) => l.id === id);

  const fake = {
    addSource: vi.fn((id: string, _def: unknown) => {
      sources.set(id, { setData: vi.fn() });
    }),
    removeSource: vi.fn((id: string) => {
      sources.delete(id);
    }),
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
    getStyle: vi.fn(() => ({ layers: [...layers] })),
    isStyleLoaded: vi.fn(() => true),
    queryRenderedFeatures: vi.fn(() => [] as unknown[]),
    getCanvas: vi.fn(() => canvas),
    on: vi.fn((event: string, layerOrFn: unknown, maybeFn?: unknown) => {
      if (typeof layerOrFn === "function") {
        handlers.push({ event, layerId: undefined, fn: layerOrFn as RegisteredHandler["fn"] });
      } else {
        handlers.push({
          event,
          layerId: layerOrFn as string,
          fn: maybeFn as RegisteredHandler["fn"],
        });
      }
    }),
    off: vi.fn((event: string, layerOrFn: unknown, maybeFn?: unknown) => {
      const layerId = typeof layerOrFn === "function" ? undefined : (layerOrFn as string);
      const fn = typeof layerOrFn === "function" ? layerOrFn : maybeFn;
      const i = handlers.findIndex(
        (h) => h.event === event && h.layerId === layerId && h.fn === fn,
      );
      if (i >= 0) handlers.splice(i, 1);
    }),

    // -- test-only helpers -------------------------------------------------
    /**
     * Dispatch `event` in registration order. Generic handlers always fire;
     * layer-scoped handlers fire only when `layerFeatures` lists features
     * for their layer (MapLibre's hit-test contract).
     */
    fire(event: string, e: Record<string, unknown> = {}, layerFeatures: Record<string, unknown[]> = {}) {
      for (const h of [...handlers]) {
        if (h.event !== event) continue;
        if (h.layerId === undefined) {
          h.fn(e);
        } else {
          const features = layerFeatures[h.layerId];
          if (features !== undefined && features.length > 0) {
            h.fn({ ...e, features });
          }
        }
      }
    },
    /** Simulate map.setStyle wiping every custom source and layer. */
    wipeStyle() {
      layers.length = 0;
      sources.clear();
    },
    handlers,
    hasLayer: (id: string) => layerIdx(id) >= 0,
    hasSource: (id: string) => sources.has(id),
    /** Current style order, bottom to top. */
    layerOrder: () => layers.map((l) => l.id),
  };
  return fake;
}

type FakeMap = ReturnType<typeof createFakeMap>;
const asMap = (fake: FakeMap) => fake as unknown as maplibregl.Map;

function setStore(overrides: Partial<ReturnType<typeof useBikeShareStore.getState>>) {
  act(() => {
    useBikeShareStore.setState({
      enabled: true,
      cityId: "vilnius",
      stations: [makeStation("s1")],
      ...overrides,
    });
  });
}

beforeEach(() => {
  useBikeShareStore.setState(initialBikeShareState, true);
});

afterEach(() => {
  cleanup();
});

describe("findBeforeId fallback chain", () => {
  test("uses an overlay that is below the stop layers", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "guidance-leg-layer-0" });
    fake.addLayer({ id: "stops-clusters" });
    expect(findBeforeId(asMap(fake))).toBe("guidance-leg-layer-0");
  });

  test("uses stops-clusters when an appended line overlay sits above it", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "stops-clusters" });
    fake.addLayer({ id: "line-route-line" });
    expect(findBeforeId(asMap(fake))).toBe("stops-clusters");
  });

  test("falls back to stops-clusters when no overlay is mounted", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "stops-clusters" });
    expect(findBeforeId(asMap(fake))).toBe("stops-clusters");
  });

  test("returns undefined (append on top) when neither exists", () => {
    const fake = createFakeMap();
    expect(findBeforeId(asMap(fake))).toBeUndefined();
  });
});

describe("re-anchor above a late basemap merge", () => {
  // mergeCartoIntoRunningMap inserts every Carto layer before
  // `stops-clusters` — the exact anchor the bike layers used at mount, so
  // the merged basemap lands ON TOP of the bikes and hides them.
  const simulateCartoMerge = (fake: FakeMap, ids: string[]) => {
    for (const id of ids) fake.addLayer({ id }, "stops-clusters");
  };

  test("basemap merged after mount: bikes hop back up, directly below the clusters", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "stops-clusters" });
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    simulateCartoMerge(fake, ["carto-water", "carto-land"]);
    expect(fake.layerOrder()).toEqual([
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "carto-water",
      "carto-land",
      "stops-clusters",
    ]);

    act(() => {
      fake.fire("styledata");
    });

    expect(fake.layerOrder()).toEqual([
      "carto-water",
      "carto-land",
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "stops-clusters",
    ]);

    // The moveLayer above fires styledata again on a real map — the
    // re-entrant run must be a no-op, never a loop.
    const moveCalls = fake.moveLayer.mock.calls.length;
    act(() => {
      fake.fire("styledata");
    });
    expect(fake.moveLayer.mock.calls.length).toBe(moveCalls);
  });

  test("basemap merged ABOVE a route overlay buries both: bikes re-anchor now, not when the overlay repairs", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "stops-clusters" });
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    // A guidance leg mounts above the bikes (its own stops-clusters anchor),
    // THEN the late Carto merge lands above the leg — burying leg and bikes.
    fake.addLayer({ id: "guidance-leg-layer-0" }, "stops-clusters");
    simulateCartoMerge(fake, ["carto-land"]);
    expect(fake.layerOrder()).toEqual([
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "guidance-leg-layer-0",
      "carto-land",
      "stops-clusters",
    ]);

    // The buried leg is NOT a valid anchor: rafScheduler only repairs a leg
    // on a later re-enqueue, which a static leg may never get. The bikes
    // must hop over it — briefly above the route line, but visible.
    act(() => {
      fake.fire("styledata");
    });
    expect(fake.layerOrder()).toEqual([
      "guidance-leg-layer-0",
      "carto-land",
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "stops-clusters",
    ]);

    // Re-entrant styledata from our own moveLayer: stable, never a loop.
    const moveCalls = fake.moveLayer.mock.calls.length;
    act(() => {
      fake.fire("styledata");
    });
    expect(fake.moveLayer.mock.calls.length).toBe(moveCalls);

    // When rafScheduler DOES repair the leg, its moveLayer's styledata
    // restores bikes-below-route-line ordering (and stays stable).
    fake.moveLayer("guidance-leg-layer-0", "stops-clusters");
    act(() => {
      fake.fire("styledata");
    });
    expect(fake.layerOrder()).toEqual([
      "carto-land",
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "guidance-leg-layer-0",
      "stops-clusters",
    ]);
  });

  test("route overlay already above the merged basemap: bikes slot in directly below the overlay", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "stops-clusters" });
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    // Carto merge first, THEN a guidance leg mounts (anchored to the
    // clusters) — the leg is fine, only the bikes are buried.
    simulateCartoMerge(fake, ["carto-land"]);
    fake.addLayer({ id: "guidance-leg-layer-0" }, "stops-clusters");
    expect(fake.layerOrder()).toEqual([
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "carto-land",
      "guidance-leg-layer-0",
      "stops-clusters",
    ]);

    act(() => {
      fake.fire("styledata");
    });
    expect(fake.layerOrder()).toEqual([
      "carto-land",
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "guidance-leg-layer-0",
      "stops-clusters",
    ]);

    // Re-entrant styledata: only the overlay remains above — stable.
    const moveCalls = fake.moveLayer.mock.calls.length;
    act(() => {
      fake.fire("styledata");
    });
    expect(fake.moveLayer.mock.calls.length).toBe(moveCalls);
  });

  test("mixed window (buried leg below basemap below intact leg): bikes anchor under the intact leg", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "stops-clusters" });
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    fake.addLayer({ id: "guidance-leg-layer-0" }, "stops-clusters");
    simulateCartoMerge(fake, ["carto-land"]);
    fake.addLayer({ id: "guidance-leg-layer-1" }, "stops-clusters");
    expect(fake.layerOrder()).toEqual([
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "guidance-leg-layer-0",
      "carto-land",
      "guidance-leg-layer-1",
      "stops-clusters",
    ]);

    act(() => {
      fake.fire("styledata");
    });
    // Bikes hop above the basemap (and the buried leg-0) but stay below
    // leg-1, the lowest overlay above every foreign layer.
    expect(fake.layerOrder()).toEqual([
      "guidance-leg-layer-0",
      "carto-land",
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "guidance-leg-layer-1",
      "stops-clusters",
    ]);
  });

  test("no landmarks are left as placed", () => {
    // No stops-clusters on the map at all.
    const noClusters = createFakeMap();
    noClusters.addLayer({ id: BIKE_CIRCLE_LAYER });
    noClusters.addLayer({ id: BIKE_LABEL_LAYER });
    noClusters.addLayer({ id: "carto-land" });
    reanchorAboveBasemap(asMap(noClusters));
    expect(noClusters.moveLayer).not.toHaveBeenCalled();
  });

  test("bikes mounted above clusters under an appended line overlay are repaired", () => {
    const aboveClusters = createFakeMap();
    aboveClusters.addLayer({ id: "stops-clusters" });
    aboveClusters.addLayer({ id: BIKE_CIRCLE_LAYER });
    aboveClusters.addLayer({ id: BIKE_LABEL_LAYER });
    aboveClusters.addLayer({ id: "line-route-line" });
    reanchorAboveBasemap(asMap(aboveClusters));
    expect(aboveClusters.layerOrder()).toEqual([
      BIKE_CIRCLE_LAYER,
      BIKE_LABEL_LAYER,
      "stops-clusters",
      "line-route-line",
    ]);
  });
});

describe("BikeShareLayer lifecycle", () => {
  test("enabled mount adds source, both layers, and three handlers", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);

    expect(fake.hasSource(BIKE_SOURCE)).toBe(true);
    expect(fake.hasLayer(BIKE_CIRCLE_LAYER)).toBe(true);
    expect(fake.hasLayer(BIKE_LABEL_LAYER)).toBe(true);
    expect(fake.handlers.map((h) => h.event).sort()).toEqual([
      "click",
      "mouseenter",
      "mouseleave",
      "styledata",
    ]);
  });

  test("uses opaque circles and the contrast-safe count-label expression", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);

    const circle = fake.addLayer.mock.calls.find(
      ([def]) => def.id === BIKE_CIRCLE_LAYER,
    )?.[0] as { paint?: Record<string, unknown> } | undefined;
    const label = fake.addLayer.mock.calls.find(
      ([def]) => def.id === BIKE_LABEL_LAYER,
    )?.[0] as { paint?: Record<string, unknown> } | undefined;
    expect(circle?.paint?.["circle-opacity"]).toBe(1);
    expect(label?.paint?.["text-color"]).toEqual(BIKE_LABEL_COLOR);
  });

  test("disabled renders nothing and adds nothing", () => {
    const fake = createFakeMap();
    setStore({ enabled: false });
    render(<BikeShareLayer map={asMap(fake)} />);
    expect(fake.addSource).not.toHaveBeenCalled();
    expect(fake.addLayer).not.toHaveBeenCalled();
  });

  test("a poll update goes through setData — no layer/source teardown or re-add", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    const addSourceCalls = fake.addSource.mock.calls.length;
    const addLayerCalls = fake.addLayer.mock.calls.length;
    const source = fake.getSource(BIKE_SOURCE)!;

    setStore({ stations: [makeStation("s1", 2), makeStation("s2", 0)] });

    expect(source.setData).toHaveBeenCalledTimes(2); // mount + update
    const data = source.setData.mock.calls.at(-1)![0] as GeoJSON.FeatureCollection;
    expect(data.features).toHaveLength(2);
    expect(fake.addSource.mock.calls.length).toBe(addSourceCalls);
    expect(fake.addLayer.mock.calls.length).toBe(addLayerCalls);
    expect(fake.removeLayer).not.toHaveBeenCalled();
    expect(fake.removeSource).not.toHaveBeenCalled();
  });

  test("toggle-off removes both layers, the source, and the handlers", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    setStore({ enabled: false });

    expect(fake.hasLayer(BIKE_CIRCLE_LAYER)).toBe(false);
    expect(fake.hasLayer(BIKE_LABEL_LAYER)).toBe(false);
    expect(fake.hasSource(BIKE_SOURCE)).toBe(false);
    expect(fake.handlers).toHaveLength(0);
  });

  test("a style swap (styledata with layers gone) re-adds source and layers", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    expect(fake.hasLayer(BIKE_CIRCLE_LAYER)).toBe(true);

    // Theme toggle: map.setStyle wipes every custom layer, then styledata
    // fires once the new style is ready.
    act(() => {
      fake.wipeStyle();
      fake.fire("styledata");
    });

    expect(fake.hasSource(BIKE_SOURCE)).toBe(true);
    expect(fake.hasLayer(BIKE_CIRCLE_LAYER)).toBe(true);
    expect(fake.hasLayer(BIKE_LABEL_LAYER)).toBe(true);
  });

  test("styledata with layers intact does NOT churn the layer", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    const addSourceCalls = fake.addSource.mock.calls.length;

    act(() => {
      fake.fire("styledata");
    });
    expect(fake.addSource.mock.calls.length).toBe(addSourceCalls);
  });
});

describe("BikeShareLayer tap handling", () => {
  const bikeFeature = (stationId: unknown) => ({ properties: { stationId } });

  test("circle tap selects the station", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);

    act(() => {
      fake.fire("click", { point: { x: 1, y: 1 } }, { [BIKE_CIRCLE_LAYER]: [bikeFeature("s1")] });
    });
    expect(useBikeShareStore.getState().selectedStationId).toBe("s1");
  });

  test("a tap shared with an interactive stop layer is ceded to the stop", () => {
    const fake = createFakeMap();
    fake.addLayer({ id: "stops-dot" });
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);
    // The hit-test finds a stop feature under the same point.
    fake.queryRenderedFeatures.mockReturnValue([{ id: "stop-1" }]);

    act(() => {
      fake.fire("click", { point: { x: 1, y: 1 } }, { [BIKE_CIRCLE_LAYER]: [bikeFeature("s1")] });
    });
    expect(useBikeShareStore.getState().selectedStationId).toBeNull();
  });

  test("a non-string stationId property never selects (type guard)", () => {
    const fake = createFakeMap();
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);

    act(() => {
      fake.fire("click", { point: { x: 1, y: 1 } }, { [BIKE_CIRCLE_LAYER]: [bikeFeature(42)] });
    });
    expect(useBikeShareStore.getState().selectedStationId).toBeNull();
  });

  test("Home's tap pipeline: generic clear first, then circle select — sheet opens", () => {
    const fake = createFakeMap();
    // Mirror TransitMap/Home: the generic map click (which closes the bike
    // sheet on empty-map taps) registers during map init, BEFORE
    // BikeShareLayer mounts and registers its circle handler.
    fake.on("click", () => {
      useBikeShareStore.getState().clearStationSelection();
    });
    setStore({});
    render(<BikeShareLayer map={asMap(fake)} />);

    // Tap ON a bike marker: generic handler clears, circle handler (fires
    // second, in registration order) re-selects — net: the sheet opens.
    act(() => {
      fake.fire("click", { point: { x: 1, y: 1 } }, { [BIKE_CIRCLE_LAYER]: [bikeFeature("s1")] });
    });
    expect(useBikeShareStore.getState().selectedStationId).toBe("s1");

    // Tap on empty map: only the generic handler fires — the sheet closes.
    act(() => {
      fake.fire("click", { point: { x: 2, y: 2 } });
    });
    expect(useBikeShareStore.getState().selectedStationId).toBeNull();
  });
});
