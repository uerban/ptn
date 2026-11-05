import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// Hoisted mock state — each test resets the values exposed to the
// component via the hooks below.
const liveQueryReturn: { value: unknown } = { value: [] };
const raptorIndexReturn: {
  value: { routes: { id: string; stopIds: string[] }[]; routeIdToIdx: Map<string, number> } | null;
} = { value: null };

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_query: () => unknown) => liveQueryReturn.value,
}));
vi.mock("../../src/stores/gtfsDataStore.ts", () => ({
  useGtfsDataStore: (selector: (s: { raptorIndex: unknown }) => unknown) =>
    selector({ raptorIndex: raptorIndexReturn.value }),
}));
vi.mock("../../src/db/index.ts", () => ({
  db: { gtfsStops: { bulkGet: vi.fn() } },
}));

import { TransitLegPreviewLayer } from "../../src/components/Map/legLayers/TransitLegPreviewLayer.tsx";

const baseLeg = {
  mode: "BUS",
  from: { name: "Board", location: { lat: 54.20, lon: 25.20 }, stopId: "B" },
  to: { name: "Alight", location: { lat: 54.40, lon: 25.40 }, stopId: "D" },
  departureTime: "",
  arrivalTime: "",
  durationSeconds: 300,
  tripId: "T1",
  routeId: "R1",
  boardStopIdx: 1,
  alightStopIdx: 3,
  routeColor: "ff8800",
} as const;

const stops = {
  A: { id: "A", name: "A", lat: 54.10, lon: 25.10 },
  E: { id: "E", name: "E", lat: 54.50, lon: 25.50 },
};

function makeMap() {
  return {
    addSource: vi.fn(),
    addLayer: vi.fn(),
    getSource: vi.fn(() => undefined),
    getLayer: vi.fn(() => undefined),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
    setPaintProperty: vi.fn(),
  };
}

describe("TransitLegPreviewLayer", () => {
  beforeEach(() => {
    raptorIndexReturn.value = {
      // Route stops: ["A", "B", "C", "D", "E"] — leg covers indices 1..3
      // (B → C → D); previews are A (pre) and E (post).
      routes: [{ id: "R1", stopIds: ["A", "B", "C", "D", "E"] }],
      routeIdToIdx: new Map([["R1", 0]]),
    };
    liveQueryReturn.value = [stops.A, stops.E];
  });

  it("renders pre + post preview features for a current leg", () => {
    const map = makeMap();
    render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={2}
        status="current"
      />,
    );

    expect(map.addSource).toHaveBeenCalledTimes(1);
    const [, sourceArg] = map.addSource.mock.calls[0];
    const data = sourceArg.data as GeoJSON.FeatureCollection;
    expect(data.features).toHaveLength(2);
    expect((data.features[0].geometry as GeoJSON.LineString).coordinates).toEqual([
      [25.10, 54.10],
      [25.20, 54.20],
    ]);
    expect((data.features[1].geometry as GeoJSON.LineString).coordinates).toEqual([
      [25.40, 54.40],
      [25.50, 54.50],
    ]);
  });

  it("renders only the pre preview feature for an upcoming leg", () => {
    liveQueryReturn.value = [stops.A];
    const map = makeMap();
    render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={2}
        status="upcoming"
      />,
    );

    expect(map.addSource).toHaveBeenCalledTimes(1);
    const [, sourceArg] = map.addSource.mock.calls[0];
    const data = sourceArg.data as GeoJSON.FeatureCollection;
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties?.kind).toBe("pre");
  });

  it("does not render anything for completed or future legs", () => {
    const map = makeMap();
    render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={2}
        status="completed"
      />,
    );
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
  });

  it("skips the pre feature when boardStopIdx is the first stop on the route", () => {
    raptorIndexReturn.value = {
      routes: [{ id: "R1", stopIds: ["B", "C", "D", "E"] }],
      routeIdToIdx: new Map([["R1", 0]]),
    };
    liveQueryReturn.value = [stops.E];
    const map = makeMap();
    render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={{ ...baseLeg, boardStopIdx: 0, alightStopIdx: 2 }}
        index={0}
        status="current"
      />,
    );
    const [, sourceArg] = map.addSource.mock.calls[0];
    const data = sourceArg.data as GeoJSON.FeatureCollection;
    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties?.kind).toBe("post");
  });

  it("renders nothing when raptorIndex is unavailable", () => {
    raptorIndexReturn.value = null;
    const map = makeMap();
    render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={0}
        status="current"
      />,
    );
    expect(map.addSource).not.toHaveBeenCalled();
  });

  it("removes the source and layer when status flips from current to completed", () => {
    const map = makeMap();
    // Pretend the layer was already added: any subsequent status flip that
    // disables the preview should call removeLayer + removeSource.
    let added = false;
    map.getLayer.mockImplementation(() => (added ? "guidance-leg-preview-layer-2" : undefined));
    map.getSource.mockImplementation(() => (added ? {} : undefined));
    map.addSource.mockImplementation(() => { added = true; });

    const { rerender } = render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={2}
        status="current"
      />,
    );
    expect(map.addSource).toHaveBeenCalledTimes(1);

    rerender(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={2}
        status="completed"
      />,
    );
    expect(map.removeLayer).toHaveBeenCalledWith("guidance-leg-preview-layer-2");
    expect(map.removeSource).toHaveBeenCalledWith("guidance-leg-preview-2");
  });

  it("renders nothing while the neighbours live-query is still pending", () => {
    // useLiveQuery returns `undefined` until Dexie emits the first value.
    liveQueryReturn.value = undefined;
    const map = makeMap();
    render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={0}
        status="current"
      />,
    );
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
  });

  it("inserts the preview below the main leg layer when present", () => {
    const map = makeMap();
    map.getLayer.mockImplementation((id: string) =>
      id === "guidance-leg-layer-2" ? id : undefined,
    );
    render(
      <TransitLegPreviewLayer
        map={map as any}
        leg={baseLeg}
        index={2}
        status="current"
      />,
    );
    expect(map.addLayer).toHaveBeenCalledTimes(1);
    const [, beforeId] = map.addLayer.mock.calls[0];
    expect(beforeId).toBe("guidance-leg-layer-2");
  });

  afterEach(() => cleanup());
});
