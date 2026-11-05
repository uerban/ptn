import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { RouteOverlay } from "../../src/components/Map/RouteOverlay.tsx";

vi.mock("../../src/components/Map/legLayers/TransitLegLayer.tsx", () => ({
  TransitLegLayer: () => <div data-testid="transit-leg" />,
}));
vi.mock(
  "../../src/components/Map/legLayers/TransitLegPreviewLayer.tsx",
  () => ({
    TransitLegPreviewLayer: ({ status }: { status: string }) => (
      <div data-testid="transit-leg-preview" data-status={status} />
    ),
  }),
);
vi.mock("../../src/components/Map/legLayers/WalkLegLayer.tsx", () => ({
  WalkLegLayer: () => <div data-testid="walk-leg" />,
}));

const mapStub = {
  on: vi.fn(),
  off: vi.fn(),
  getLayer: () => undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("RouteOverlay", () => {
  it("renders one TransitLegLayer per transit leg", () => {
    const itin = {
      legs: [
        {
          mode: "BUS",
          from: { name: "a", location: { lat: 0, lon: 0 }, stopId: "A" },
          to: { name: "b", location: { lat: 1, lon: 1 }, stopId: "B" },
          departureTime: "",
          arrivalTime: "",
          durationSeconds: 300,
          tripId: "T1",
          routeId: "R1",
          boardStopIdx: 0,
          alightStopIdx: 2,
        },
      ],
      departureTime: "",
      arrivalTime: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const { queryAllByTestId } = render(
      <RouteOverlay map={mapStub} itinerary={itin} legStatuses={["current"]} />,
    );
    expect(queryAllByTestId("transit-leg")).toHaveLength(1);
    expect(queryAllByTestId("walk-leg")).toHaveLength(0);
  });

  it("mounts a preview layer alongside each transit leg, threading the status through", () => {
    const itin = {
      legs: [
        {
          mode: "BUS",
          from: { name: "a", location: { lat: 0, lon: 0 }, stopId: "A" },
          to: { name: "b", location: { lat: 1, lon: 1 }, stopId: "B" },
          departureTime: "",
          arrivalTime: "",
          durationSeconds: 300,
          tripId: "T1",
          routeId: "R1",
          boardStopIdx: 0,
          alightStopIdx: 2,
        },
        {
          mode: "BUS",
          from: { name: "b", location: { lat: 1, lon: 1 }, stopId: "B" },
          to: { name: "c", location: { lat: 2, lon: 2 }, stopId: "C" },
          departureTime: "",
          arrivalTime: "",
          durationSeconds: 200,
          tripId: "T2",
          routeId: "R2",
          boardStopIdx: 0,
          alightStopIdx: 1,
        },
      ],
      departureTime: "",
      arrivalTime: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const { queryAllByTestId } = render(
      <RouteOverlay
        map={mapStub}
        itinerary={itin}
        legStatuses={["current", "upcoming"]}
      />,
    );
    const previews = queryAllByTestId("transit-leg-preview");
    expect(previews).toHaveLength(2);
    expect(previews[0].dataset.status).toBe("current");
    expect(previews[1].dataset.status).toBe("upcoming");
  });

  it("renders a WalkLegLayer for each walk leg", () => {
    const walkItin = {
      legs: [
        {
          mode: "WALK",
          from: { name: "a", location: { lat: 0, lon: 0 } },
          to: { name: "b", location: { lat: 1, lon: 1 } },
          departureTime: "",
          arrivalTime: "",
          durationSeconds: 60,
        },
      ],
      departureTime: "",
      arrivalTime: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const { queryAllByTestId } = render(
      <RouteOverlay map={mapStub} itinerary={walkItin} legStatuses={["current"]} />,
    );
    expect(queryAllByTestId("walk-leg")).toHaveLength(1);
  });

  it("returns null when map or itinerary is missing", () => {
    const { container: noMap } = render(
      <RouteOverlay map={null} itinerary={null} legStatuses={[]} />,
    );
    expect(noMap.firstChild).toBeNull();
  });

  it("registers and cleans up styledata listener", () => {
    const on = vi.fn();
    const off = vi.fn();
    const map = {
      on,
      off,
      getLayer: () => undefined,
      isStyleLoaded: () => true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const itin = {
      legs: [
        {
          mode: "BUS",
          from: { name: "a", location: { lat: 0, lon: 0 }, stopId: "A" },
          to: { name: "b", location: { lat: 1, lon: 1 }, stopId: "B" },
          departureTime: "",
          arrivalTime: "",
          durationSeconds: 300,
          tripId: "T1",
          routeId: "R1",
          boardStopIdx: 0,
          alightStopIdx: 2,
        },
      ],
      departureTime: "",
      arrivalTime: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const { unmount } = render(
      <RouteOverlay map={map} itinerary={itin} legStatuses={["current"]} />,
    );
    expect(on).toHaveBeenCalledWith("styledata", expect.any(Function));
    unmount();
    expect(off).toHaveBeenCalledWith("styledata", expect.any(Function));
  });

  it("does not call getLayer when styledata fires before the style is loaded", () => {
    // MapLibre fires `styledata` multiple times during a style swap /
    // initial load. In the early firings `map.style` can still be
    // undefined, and a naive `getLayer` would throw. This test captures
    // the listener, fires it before the style is loaded, and asserts
    // nothing throws and `getLayer` is not reached — the bump to
    // styleRev (and thus the subsequent child remount) waits for
    // `isStyleLoaded()` to return true.
    let registered: (() => void) | null = null;
    const getLayer = vi.fn(() => undefined);
    const isStyleLoaded = vi.fn(() => false);
    const map = {
      on: vi.fn((evt: string, cb: () => void) => {
        if (evt === "styledata") registered = cb;
      }),
      off: vi.fn(),
      getLayer,
      isStyleLoaded,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const itin = {
      legs: [
        {
          mode: "BUS",
          from: { name: "a", location: { lat: 0, lon: 0 }, stopId: "A" },
          to: { name: "b", location: { lat: 1, lon: 1 }, stopId: "B" },
          departureTime: "",
          arrivalTime: "",
          durationSeconds: 300,
          tripId: "T1",
          routeId: "R1",
          boardStopIdx: 0,
          alightStopIdx: 2,
        },
      ],
      departureTime: "",
      arrivalTime: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    render(
      <RouteOverlay map={map} itinerary={itin} legStatuses={["current"]} />,
    );
    expect(registered).not.toBeNull();
    expect(() => registered!()).not.toThrow();
    expect(isStyleLoaded).toHaveBeenCalled();
    expect(getLayer).not.toHaveBeenCalled();
  });

  it("calls getLayer once styledata fires after the style is loaded", () => {
    let registered: (() => void) | null = null;
    const getLayer = vi.fn(() => undefined);
    const map = {
      on: vi.fn((evt: string, cb: () => void) => {
        if (evt === "styledata") registered = cb;
      }),
      off: vi.fn(),
      getLayer,
      isStyleLoaded: () => true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const itin = {
      legs: [
        {
          mode: "BUS",
          from: { name: "a", location: { lat: 0, lon: 0 }, stopId: "A" },
          to: { name: "b", location: { lat: 1, lon: 1 }, stopId: "B" },
          departureTime: "",
          arrivalTime: "",
          durationSeconds: 300,
          tripId: "T1",
          routeId: "R1",
          boardStopIdx: 0,
          alightStopIdx: 2,
        },
      ],
      departureTime: "",
      arrivalTime: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    render(
      <RouteOverlay map={map} itinerary={itin} legStatuses={["current"]} />,
    );
    registered!();
    expect(getLayer).toHaveBeenCalled();
  });
});
