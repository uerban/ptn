import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LatLon } from "@pt/shared";
import { SearchMapPicker } from "./SearchMapPicker.tsx";
import { useMapTapStore } from "../../stores/mapTapStore.ts";

const mocks = vi.hoisted(() => ({
  map: { getCenter: () => ({ lat: 54.687251, lng: 25.279734 }) },
  remove: vi.fn(),
}));
vi.mock("../../hooks/useStopPreloader.ts", () => ({ useStopPreloader: () => {} }));
vi.mock("../../map/maplibre.ts", () => ({ default: { Marker: class {
  setLngLat() { return this; }
  addTo() { return this; }
  remove() { mocks.remove(); }
} } }));
vi.mock("../Map/TransitMap.tsx", () => ({
  TransitMap: ({ onMapReady, onMapClick }: { onMapReady: (map: unknown) => void; onMapClick: (point: LatLon) => void }) => {
    useEffect(() => onMapReady(mocks.map), [onMapReady]);
    return <button onClick={() => onMapClick({ lat: 54.687251, lon: 25.279734 })}>Tap map</button>;
  },
}));
vi.mock("../Map/MicromapLayer.tsx", () => ({ MicromapLayer: () => null }));
vi.mock("../Map/GtfsCorridorLayer.tsx", () => ({ GtfsCorridorLayer: () => null }));
vi.mock("../Map/MapTapActionSheet.tsx", () => ({ MapTapActionSheet: () => {
  const raw = useMapTapStore(s => s.rawTap);
  return raw ? <div role="dialog" aria-label="Dropped pin"><button>Confirm place</button></div> : null;
} }));

beforeEach(() => { useMapTapStore.getState().clear(); mocks.remove.mockClear(); });
describe("Search map picker", () => {
  it("drops an in-memory pin, focuses confirmation, and clears it on unmount", () => {
    const view = render(<SearchMapPicker field="to" onSelect={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap map" }));
    expect(useMapTapStore.getState().rawTap).toEqual({ lat: 54.687251, lon: 25.279734 });
    expect(screen.getByRole("button", { name: "Confirm place" })).toHaveFocus();
    view.unmount();
    expect(useMapTapStore.getState().rawTap).toBeNull();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
  it("provides a map-centre action and supports Escape cancellation", () => {
    const onCancel = vi.fn();
    const view = render(<SearchMapPicker field="from" onSelect={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose map centre" }));
    expect(useMapTapStore.getState().rawTap).toEqual({ lat: 54.687251, lon: 25.279734 });
    fireEvent.keyDown(screen.getByRole("button", { name: "Confirm place" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    view.unmount();
  });
});
