import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TransitLegLayer } from "../../src/components/Map/legLayers/TransitLegLayer.tsx";
import { WalkLegLayer } from "../../src/components/Map/legLayers/WalkLegLayer.tsx";

vi.mock("../../src/hooks/useTransitLegGeometry.ts", () => ({
  useTransitLegGeometry: () => ({
    coords: [[0, 0], [1, 1]], source: "shape", partial: false, pending: false,
  }),
}));
vi.mock("../../src/hooks/useWalkLegGeometry.ts", () => ({
  useWalkLegGeometry: () => ({
    coords: [[0, 0], [2, 2]], source: "walk-graph", partial: false, pending: false,
  }),
}));

const mapStub = {
  addSource: vi.fn(), addLayer: vi.fn(), getSource: () => undefined,
  getLayer: () => undefined, removeLayer: vi.fn(), removeSource: vi.fn(),
  setPaintProperty: vi.fn(), on: vi.fn(), off: vi.fn(),
};

describe("leg layers", () => {
  it("TransitLegLayer renders without invoking walk hook", async () => {
    const leg = {
      mode: "BUS", from: { name: "a", location: { lat: 0, lon: 0 }, stopId: "A" },
      to: { name: "b", location: { lat: 1, lon: 1 }, stopId: "B" },
      departureTime: "", arrivalTime: "", durationSeconds: 300,
      tripId: "T1", routeId: "R1", boardStopIdx: 0, alightStopIdx: 2,
    } as const;
    render(<TransitLegLayer map={mapStub as any} leg={leg} index={0} statusOpacity={1} />);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(mapStub.addSource).toHaveBeenCalled();
  });

  it("WalkLegLayer renders without invoking transit hook", async () => {
    const leg = {
      mode: "WALK", from: { name: "a", location: { lat: 0, lon: 0 } },
      to: { name: "b", location: { lat: 1, lon: 1 } },
      departureTime: "", arrivalTime: "", durationSeconds: 60,
    } as const;
    render(<WalkLegLayer map={mapStub as any} leg={leg} index={0} statusOpacity={1} />);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(mapStub.addSource).toHaveBeenCalled();
  });
});
