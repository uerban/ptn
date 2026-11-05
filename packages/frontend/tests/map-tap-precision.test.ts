import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  LEVEL_FLOORS,
  PRIVACY_LEVELS,
  type PrivacyLevel,
  type PrivacyPolicy,
} from "@pt/shared";
import { useMapTapStore } from "../src/stores/mapTapStore.ts";
import { useRoutingStore } from "../src/stores/routingStore.ts";
import { usePrivacyStore } from "../src/stores/privacyStore.ts";
import { db } from "../src/db/index.ts";

const ITERATIONS = 1000;
const EARTH_LAT_METERS_PER_DEG = 111_320;

// Deterministic RNG so a failing seed reproduces. Mulberry32 — small, fast,
// well-distributed enough for fuzzing precision invariants.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLatLon(rng: () => number): { lat: number; lon: number } {
  // Pick a real lat (avoid the poles where lon snapping diverges) and a full
  // lon range — populated transit cities span -85..85 lat / -180..180 lon.
  const lat = (rng() - 0.5) * 170; // ±85°
  const lon = (rng() - 0.5) * 360; // ±180°
  return { lat, lon };
}

function gridStep(lat: number, meters: number): { lat: number; lon: number } {
  const latStep = meters / EARTH_LAT_METERS_PER_DEG;
  const lonStep =
    meters / (EARTH_LAT_METERS_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return { lat: latStep, lon: lonStep };
}

function assertOnGrid(lat: number, lon: number, meters: number): void {
  const step = gridStep(lat, meters);
  // Floating-point tolerance proportional to the step size — a single
  // round-trip through Math.round introduces at most ~1e-10 relative error.
  const tol = 1e-9;
  const latMul = lat / step.lat;
  const lonMul = lon / step.lon;
  expect(Math.abs(latMul - Math.round(latMul))).toBeLessThan(tol);
  expect(Math.abs(lonMul - Math.round(lonMul))).toBeLessThan(tol);
}

function precisionMatches(
  precision: PrivacyPolicy["mapTapPersistedPrecision"],
  raw: { lat: number; lon: number },
  stored: { lat: number; lon: number },
): void {
  switch (precision) {
    case "raw":
    case "snap-centroid":
      // Pass-through: the stored value equals the raw input. The precision
      // axis at these levels does not coarsen — coarsening is opt-in via the
      // user-override ratchet.
      expect(stored.lat).toBe(raw.lat);
      expect(stored.lon).toBe(raw.lon);
      return;
    case "snap-rounded-50m":
      assertOnGrid(stored.lat, stored.lon, 50);
      return;
    case "snap-rounded-100m":
    case "snap-rounded-100m-no-reverse":
      assertOnGrid(stored.lat, stored.lon, 100);
      return;
  }
}

// Spies for the three cross-boundary egress paths a tap could leak through.
// All three should be silent for the entire tap → confirm → setOrigin flow at
// every level: M7b only writes to the in-memory routingStore.
type WriteSpy = {
  history: ReturnType<typeof vi.spyOn>;
  replaceState: ReturnType<typeof vi.spyOn>;
  dbAdd: ReturnType<typeof vi.spyOn>;
  dbPut: ReturnType<typeof vi.spyOn>;
};

function installEgressSpies(): WriteSpy {
  return {
    history: vi.spyOn(window.history, "pushState"),
    replaceState: vi.spyOn(window.history, "replaceState"),
    // Spy at the Dexie boundary: any future recentLocations / savedLocations
    // table will go through table.add() / table.put(). If M7b ever silently
    // wires up such a write, this spy fires.
    dbAdd: vi.spyOn(db.Table.prototype, "add"),
    dbPut: vi.spyOn(db.Table.prototype, "put"),
  };
}

beforeEach(() => {
  useMapTapStore.setState({ rawTap: null });
  useRoutingStore.setState({ origin: null, destination: null });
  usePrivacyStore.getState().reset();
  globalThis.localStorage?.removeItem("ptn-privacy");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("map-tap precision fuzz", () => {
  for (const level of PRIVACY_LEVELS as readonly PrivacyLevel[]) {
    const precision = LEVEL_FLOORS[level].mapTapPersistedPrecision;

    it(`level=${level} (${precision}): ${ITERATIONS} random taps respect the precision floor`, () => {
      usePrivacyStore.getState().setLevel(level);
      const rng = mulberry32(0xc0ffee ^ PRIVACY_LEVELS.indexOf(level));

      for (let i = 0; i < ITERATIONS; i++) {
        const raw = randomLatLon(rng);
        useMapTapStore.getState().emitTap(raw.lat, raw.lon);
        const ep = useMapTapStore.getState().confirmAsEndpoint();
        expect(ep, `seed=${i} level=${level}`).not.toBeNull();
        expect(ep!.kind).toBe("mappoint");
        precisionMatches(precision, raw, ep!);
      }
    });

    it(`level=${level}: routingStore.setOrigin only sees precision-respecting coords`, () => {
      usePrivacyStore.getState().setLevel(level);
      const rng = mulberry32(0xbadf00d ^ PRIVACY_LEVELS.indexOf(level));
      const setOrigin = useRoutingStore.getState().setOrigin;
      const setDestination = useRoutingStore.getState().setDestination;

      for (let i = 0; i < ITERATIONS; i++) {
        const raw = randomLatLon(rng);
        useMapTapStore.getState().emitTap(raw.lat, raw.lon);
        const ep = useMapTapStore.getState().confirmAsEndpoint();
        expect(ep).not.toBeNull();
        // Alternate origin vs. destination — the seam is symmetric.
        if (i % 2 === 0) setOrigin(ep!);
        else setDestination(ep!);

        const stored =
          i % 2 === 0
            ? useRoutingStore.getState().origin
            : useRoutingStore.getState().destination;
        expect(stored).not.toBeNull();
        expect(stored!.kind).toBe("mappoint");
        // The store must hold *exactly* what mapTap emitted — no widening or
        // re-attaching of raw coords downstream.
        expect(stored!.lat).toBe(ep!.lat);
        expect(stored!.lon).toBe(ep!.lon);
        precisionMatches(precision, raw, {
          lat: stored!.lat!,
          lon: stored!.lon!,
        });
      }
    });

    it(`level=${level}: tap → confirm → setOrigin writes nothing to URL or DB`, () => {
      usePrivacyStore.getState().setLevel(level);
      const spies = installEgressSpies();
      const rng = mulberry32(0xfeed ^ PRIVACY_LEVELS.indexOf(level));
      const setOrigin = useRoutingStore.getState().setOrigin;

      // 100 reps is enough — the egress paths are categorical, not numeric.
      for (let i = 0; i < 100; i++) {
        const raw = randomLatLon(rng);
        useMapTapStore.getState().emitTap(raw.lat, raw.lon);
        const ep = useMapTapStore.getState().confirmAsEndpoint();
        expect(ep).not.toBeNull();
        setOrigin(ep!);
      }

      expect(spies.history).not.toHaveBeenCalled();
      expect(spies.replaceState).not.toHaveBeenCalled();
      expect(spies.dbAdd).not.toHaveBeenCalled();
      expect(spies.dbPut).not.toHaveBeenCalled();
    });
  }

  it("ratcheted override: precision floor cannot be loosened by a per-axis override", () => {
    // Setting a looser override at Strict must be ignored; persistMapTap
    // sees the stricter floor (snap-rounded-100m), not the override.
    usePrivacyStore.getState().setLevel("strict");
    usePrivacyStore.getState().setOverride("mapTapPersistedPrecision", "raw");
    const rng = mulberry32(0xabcd);
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = randomLatLon(rng);
      useMapTapStore.getState().emitTap(raw.lat, raw.lon);
      const ep = useMapTapStore.getState().confirmAsEndpoint();
      expect(ep).not.toBeNull();
      assertOnGrid(ep!.lat, ep!.lon, 100);
    }
  });

  it("ratcheted override: tightening from Standard to snap-rounded-100m is honored", () => {
    usePrivacyStore.getState().setLevel("standard");
    usePrivacyStore
      .getState()
      .setOverride("mapTapPersistedPrecision", "snap-rounded-100m");
    const rng = mulberry32(0xdcba);
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = randomLatLon(rng);
      useMapTapStore.getState().emitTap(raw.lat, raw.lon);
      const ep = useMapTapStore.getState().confirmAsEndpoint();
      expect(ep).not.toBeNull();
      assertOnGrid(ep!.lat, ep!.lon, 100);
    }
  });
});
