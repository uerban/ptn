import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { SharedMobilitySystem } from "../../config/cities.ts";
import type { GbfsStation } from "../../services/gbfs/types.ts";
import { cyclocity } from "../../test-helpers/bikeShareFixtures.ts";

// bikeShareStore pulls the GBFS client and Dexie helpers in at module load;
// the sheet only reads store state, so both are mocked away.
vi.mock("../../db/index.ts", async () =>
  (await import("../../test-helpers/bikeShareFixtures.ts")).stubGbfsDb(),
);

import { BikeShareStationSheet } from "./BikeShareStationSheet.tsx";
import { useBikeShareStore } from "../../stores/bikeShareStore.ts";

const initialBikeShareState = useBikeShareStore.getState();

const liveStation: GbfsStation = {
  stationId: "s1",
  name: "Katedros aikštė",
  address: "Šventaragio g. 2",
  capacity: 20,
  lat: 54.6859,
  lon: 25.2875,
  bikesAvailable: 5,
  docksAvailable: 7,
  isInstalled: true,
  isRenting: true,
  isReturning: true,
  lastReported: 1_752_750_000,
};

/** Offline-cached shape: positions known, status unknown (null counts). */
const unknownStation: GbfsStation = {
  ...liveStation,
  bikesAvailable: null,
  docksAvailable: null,
  isRenting: false,
  isReturning: false,
  lastReported: null,
};

function setStore(overrides: Partial<ReturnType<typeof useBikeShareStore.getState>>) {
  useBikeShareStore.setState({
    enabled: true,
    cityId: "vilnius",
    systems: [cyclocity],
    stations: [liveStation],
    selectedStationId: "s1",
    ...overrides,
  });
}

beforeEach(() => {
  useBikeShareStore.setState(initialBikeShareState, true);
});

afterEach(() => {
  cleanup();
});

describe("bikeShareStore station selection", () => {
  test("selectStation sets and clearStationSelection clears the id", () => {
    expect(useBikeShareStore.getState().selectedStationId).toBeNull();
    useBikeShareStore.getState().selectStation("s1");
    expect(useBikeShareStore.getState().selectedStationId).toBe("s1");
    useBikeShareStore.getState().clearStationSelection();
    expect(useBikeShareStore.getState().selectedStationId).toBeNull();
  });

  test("disable clears the selection (sheet must not survive toggle-off)", () => {
    useBikeShareStore.getState().selectStation("s1");
    useBikeShareStore.getState().disable();
    expect(useBikeShareStore.getState().selectedStationId).toBeNull();
  });
});

describe("BikeShareStationSheet", () => {
  test("renders nothing when no station is selected", () => {
    setStore({ selectedStationId: null });
    const { container } = render(<BikeShareStationSheet />);
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing for a stale selection missing from stations", () => {
    setStore({ selectedStationId: "gone" });
    const { container } = render(<BikeShareStationSheet />);
    expect(container.innerHTML).toBe("");
  });

  test("live station shows name, address, counts, operator, and update time", () => {
    setStore({});
    render(<BikeShareStationSheet />);
    expect(screen.getByText("Katedros aikštė")).toBeDefined();
    expect(screen.getByText("Šventaragio g. 2")).toBeDefined();
    expect(screen.getByText("5 bikes · 7 docks free")).toBeDefined();
    expect(screen.getByText("Cyclocity Vilnius")).toBeDefined();
    expect(screen.getByText(/Updated/)).toBeDefined();
    // Renting normally — no flag.
    expect(screen.queryByText(/not renting/i)).toBeNull();
  });

  test("singular counts read '1 bike · 1 dock free' (plural forms)", () => {
    setStore({
      stations: [{ ...liveStation, bikesAvailable: 1, docksAvailable: 1 }],
    });
    render(<BikeShareStationSheet />);
    expect(screen.getByText("1 bike · 1 dock free")).toBeDefined();
  });

  test("bikes known but docks unknown shows only the bikes part — never a fake 0", () => {
    setStore({
      stations: [{ ...liveStation, bikesAvailable: 5, docksAvailable: null }],
    });
    render(<BikeShareStationSheet />);
    expect(screen.getByText("5 bikes")).toBeDefined();
    expect(screen.queryByText(/docks/)).toBeNull();
    expect(screen.queryByText("Availability unknown")).toBeNull();
  });

  test("docks known but bikes unknown shows only the docks part — never a fake 0", () => {
    setStore({
      stations: [{ ...liveStation, bikesAvailable: null, docksAvailable: 7 }],
    });
    render(<BikeShareStationSheet />);
    expect(screen.getByText("7 docks free")).toBeDefined();
    expect(screen.queryByText(/bike(s)? ·/)).toBeNull();
    expect(screen.queryByText("Availability unknown")).toBeNull();
  });

  test("with several configured systems the FIRST operator is credited (single-operator runtime)", () => {
    const second: SharedMobilitySystem = {
      id: "second-bikes",
      name: "Second Bikes",
      gbfsDiscoveryUrl: "https://example.test/second/gbfs.json",
    };
    setStore({ systems: [cyclocity, second] });
    render(<BikeShareStationSheet />);
    // The store only drives systems[0], so every rendered station is its —
    // attribution stays exact, and the second system is never named.
    expect(screen.getByTestId("bike-station-operator").textContent).toBe(
      "Cyclocity Vilnius",
    );
    expect(screen.queryByText("Second Bikes")).toBeNull();
  });

  test("shows the not-renting flag when status says isRenting:false", () => {
    setStore({
      stations: [{ ...liveStation, isRenting: false, bikesAvailable: 4 }],
    });
    render(<BikeShareStationSheet />);
    expect(screen.getByText(/not renting/i)).toBeDefined();
  });

  test("null counts render as unknown — never 0, and never 'not renting'", () => {
    setStore({ stations: [unknownStation] });
    render(<BikeShareStationSheet />);
    expect(screen.getByText("Availability unknown")).toBeDefined();
    expect(screen.queryByText(/0 bikes/)).toBeNull();
    expect(screen.queryByText(/0 docks/)).toBeNull();
    // No status evidence — "not renting" would be a guess, so it's absent.
    expect(screen.queryByText(/not renting/i)).toBeNull();
    // No lastReported → no update line.
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  test("close button clears the selection", () => {
    setStore({});
    render(<BikeShareStationSheet />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(useBikeShareStore.getState().selectedStationId).toBeNull();
  });
});
