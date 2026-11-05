import { describe, it, expect, vi, beforeEach } from "vitest";
import { enqueueSetData, __resetScheduler } from "../../src/components/Map/legLayers/rafScheduler.ts";

function fakeMap() {
  const sources = new Map<string, any>();
  const layers = new Map<string, any>();
  return {
    sources,
    layers,
    map: {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, src: any) => {
        sources.set(id, {
          ...src,
          setData: (d: any) => {
            sources.get(id).data = d;
            sources.get(id).__setDataCalls = (sources.get(id).__setDataCalls ?? 0) + 1;
          },
        });
      },
      addLayer: (layer: any, beforeId?: string) =>
        layers.set(layer.id, { ...layer, __beforeId: beforeId }),
      getLayer: (id: string) => layers.get(id),
      setPaintProperty: () => {},
      moveLayer: (id: string, beforeId?: string) => {
        const layer = layers.get(id);
        if (layer) {
          layer.__beforeId = beforeId;
          layer.__moveLayerCalls = (layer.__moveLayerCalls ?? 0) + 1;
        }
      },
    } as any,
  };
}

function makeLeg(_i: number): any {
  return {
    mode: "BUS",
    from: { location: { lat: 0, lon: 0 } },
    to: { location: { lat: 1, lon: 1 } },
    routeColor: "1d4ed8",
  };
}
function makeGeom(coords: [number, number][] = [[0, 0], [1, 1]]): any {
  return { coords, source: "shape", partial: false, pending: false };
}

describe("rafScheduler", () => {
  beforeEach(() => __resetScheduler());

  it("batches multiple enqueues within one frame into a single rAF callback", async () => {
    const { map, sources } = fakeMap();
    const raf = vi.spyOn(window, "requestAnimationFrame");
    for (let i = 0; i < 5; i++) {
      enqueueSetData(map, i, "transit", makeLeg(i), makeGeom(), 1);
    }
    expect(raf).toHaveBeenCalledTimes(1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    for (let i = 0; i < 5; i++) {
      expect(sources.get(`guidance-leg-${i}`)?.data.geometry.coordinates.length).toBeGreaterThan(0);
    }
    raf.mockRestore();
  });

  it("re-enqueuing the same leg index in the same frame keeps only the latest payload", async () => {
    const { map, sources } = fakeMap();
    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom([[0, 0], [1, 1]]), 1);
    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom([[0, 0], [1, 1], [2, 2]]), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(sources.get("guidance-leg-0")?.data.geometry.coordinates.length).toBe(3);
    expect(sources.get("guidance-leg-0")?.__setDataCalls ?? 0).toBeLessThanOrEqual(1);
  });

  it("setData fires at most once per leg across N back-to-back enqueues within one frame", async () => {
    const { map, sources } = fakeMap();
    // Prime the source so the subsequent enqueues go through setData, not addSource.
    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom([[0, 0], [1, 1]]), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const initialCalls = sources.get("guidance-leg-0")!.__setDataCalls ?? 0;

    // Fire ten enqueues for the same leg within the same frame.
    for (let i = 0; i < 10; i++) {
      enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom([[0, 0], [1, i + 1]]), 1);
    }
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const after = sources.get("guidance-leg-0")!.__setDataCalls ?? 0;
    // Scheduler must coalesce — at most one setData call per frame.
    expect(after - initialCalls).toBeLessThanOrEqual(1);
  });

  it("passes beforeId when the stop layer exists, omits when it doesn't", async () => {
    const { map, layers } = fakeMap();
    const addLayerSpy = vi.spyOn(map, "addLayer");

    // Case 1: stop layer absent → beforeId should be undefined (omitted).
    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom(), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(addLayerSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "guidance-leg-layer-0" }),
      undefined,
    );

    // Case 2: stop layer present → beforeId should be "stops-clusters".
    layers.set("stops-clusters", { id: "stops-clusters" });
    enqueueSetData(map, 1, "transit", makeLeg(1), makeGeom(), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(addLayerSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "guidance-leg-layer-1" }),
      "stops-clusters",
    );

    addLayerSpy.mockRestore();
  });

  it("inserts leg layer below stops-clusters when present (taps land on markers)", async () => {
    const { map, layers } = fakeMap();
    // Pre-register the stops layer the way TransitMap does — leg insertion
    // looks it up via map.getLayer(STOPS_LAYER) and uses it as beforeId.
    map.addLayer({ id: "stops-clusters", type: "circle" } as any);

    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom(), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const leg = layers.get("guidance-leg-layer-0");
    expect(leg).toBeDefined();
    expect(leg.__beforeId).toBe("stops-clusters");
  });

  it("falls back to no beforeId when stops-clusters is not yet on the map (schedule-only / pre-mount)", async () => {
    const { map, layers } = fakeMap();
    // Deliberately do NOT register a stops layer — schedule-only mode never
    // adds one, and during mount the leg can enqueue before stops are ready.

    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom(), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const leg = layers.get("guidance-leg-layer-0");
    expect(leg).toBeDefined();
    // undefined (not "stops-clusters") so MapLibre doesn't throw a
    // missing-reference-layer error.
    expect(leg.__beforeId).toBeUndefined();
  });

  it("re-positions leg layer below stops-clusters when stops mount after the first enqueue", async () => {
    const { map, layers } = fakeMap();

    // First enqueue: stops layer not yet on the map.
    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom(), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(layers.get("guidance-leg-layer-0").__beforeId).toBeUndefined();

    // Stops layer mounts later (real production order: TransitMap's stops
    // sources finish registering after the first leg enqueue arrives).
    map.addLayer({ id: "stops-clusters", type: "circle" } as any);

    // Re-enqueue same leg index. Without the re-position step in
    // rafScheduler, the leg layer would stay above stops permanently,
    // and the first user-tap on a stop after this point would hit the
    // polyline.
    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom([[0, 0], [2, 2]]), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const leg = layers.get("guidance-leg-layer-0");
    expect(leg.__beforeId).toBe("stops-clusters");
    // Exactly one re-position — guards against a regression that calls
    // moveLayer per-leg per-frame (the comment in rafScheduler claims
    // moveLayer is cheap-when-redundant, but the inner call is still
    // a style reorder, so per-frame churn would be a real cost).
    expect(leg.__moveLayerCalls).toBe(1);
  });

  it("does not re-position when stops-clusters has been removed between enqueues", async () => {
    const { map, layers } = fakeMap();
    map.addLayer({ id: "stops-clusters", type: "circle" } as any);

    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom(), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(layers.get("guidance-leg-layer-0").__beforeId).toBe("stops-clusters");

    // Style swap removes stops-clusters between paints.
    layers.delete("stops-clusters");

    enqueueSetData(map, 0, "transit", makeLeg(0), makeGeom([[0, 0], [3, 3]]), 1);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    // moveLayer must be guarded by a getLayer check so MapLibre never
    // sees a missing reference layer; this also means we don't churn
    // moveLayer when the target is gone.
    expect(layers.get("guidance-leg-layer-0").__moveLayerCalls ?? 0).toBe(0);
  });
});
