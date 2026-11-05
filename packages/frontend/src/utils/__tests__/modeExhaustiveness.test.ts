import { describe, it, expect } from "vitest";
import type { TransportMode } from "@pt/shared";
import { DEFAULT_MODE_COLORS } from "../routeColor";
import { MODE_CONFIG } from "../../components/TransportModeIcon";
import { CO2_PER_KM } from "../ecoScore"; // exported in Step 3
import { MODE_DEFAULT_COLORS } from "../stackedRing"; // exported in Step 4

// This list equals the full TransportMode union (the legacy CABLE_CAR member has been dropped; coverage is compile-checked by the exhaustive Records).
const ALL_MODES: TransportMode[] = [
  "BUS", "TRAM", "TROLLEYBUS", "METRO", "RAIL", "FERRY",
  "CABLE_TRAM", "AERIAL", "FUNICULAR", "OTHER",
  "WALK", "BIKE", "BIKE_SHARE", "SCOOTER", "CAR",
];
// The 10 route-modes route_type_to_mode can return — these MUST have an explicit
// arm in every consumer (a missing arm silently falls back to BUS/gray).
const ROUTE_MODES: TransportMode[] = [
  "BUS", "TRAM", "TROLLEYBUS", "METRO", "RAIL", "FERRY",
  "CABLE_TRAM", "AERIAL", "FUNICULAR", "OTHER",
];
const NEW_MODES: TransportMode[] = ["CABLE_TRAM", "AERIAL", "OTHER"];

describe("mode consumer completeness", () => {
  it("DEFAULT_MODE_COLORS + MODE_CONFIG cover every mode (compile-enforced Records)", () => {
    for (const m of ALL_MODES) {
      expect(DEFAULT_MODE_COLORS[m]).toBeTruthy();
      expect(MODE_CONFIG[m]?.label?.length).toBeGreaterThan(0);
      expect(MODE_CONFIG[m]?.icon?.length).toBeGreaterThan(0);
    }
  });

  // Record<string,...> maps have NO compile-time exhaustiveness — assert the KEY
  // is present (hasOwnProperty), so a dropped arm fails red instead of silently
  // falling back (ecoScore: OTHER→BUS=50; stackedRing: →gray).
  it("CO2_PER_KM has an explicit factor for every route-mode", () => {
    for (const m of ROUTE_MODES) {
      expect(Object.prototype.hasOwnProperty.call(CO2_PER_KM, m)).toBe(true);
    }
  });
  it("MODE_DEFAULT_COLORS has an explicit colour for every route-mode", () => {
    for (const m of ROUTE_MODES) {
      expect(Object.prototype.hasOwnProperty.call(MODE_DEFAULT_COLORS, m)).toBe(true);
    }
  });

  // the three new modes must be mutually distinct (don't propagate the pre-existing FUNICULAR
  // #7c3aed collision the legacy CABLE_CAR shared).
  it("new-mode default colours are pairwise distinct", () => {
    const colours = NEW_MODES.map((m) => DEFAULT_MODE_COLORS[m]);
    expect(new Set(colours).size).toBe(NEW_MODES.length);
  });

  // Distinct monochrome backgrounds too (light scheme).
  it("new-mode monochrome backgrounds are pairwise distinct", async () => {
    const { MONOCHROME_PATTERNS } = await import("../routeColor");
    const bgs = NEW_MODES.map((m) => MONOCHROME_PATTERNS[m].light.background);
    expect(new Set(bgs).size).toBe(NEW_MODES.length);
  });
});
