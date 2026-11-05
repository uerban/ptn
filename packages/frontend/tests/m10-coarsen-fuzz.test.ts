import { describe, test, beforeEach } from "vitest";
import fc from "fast-check";
import { coarsen, _resetSessionJitter } from "../src/services/coordPrivacy.ts";
import {
  buildForwardUrl,
  buildReverseUrl,
  type ThirdPartyGeocoderConfig,
} from "../src/services/geocoder/ThirdPartyGeocoderAdapter.ts";
import type { ThirdPartyProviderId } from "../src/config/geocoderProviders.ts";
import { assertNoPrecisionLeak } from "../src/services/geocoder/fetchThirdParty.ts";

const EARTH_LAT_METERS_PER_DEG = 111_320;
const FLOAT_RE = /\d+\.\d+/g;

const PROVIDERS: ThirdPartyProviderId[] = ["mapbox", "nominatim", "photon"];
const GRID_SIZES = [100, 500, 1000] as const;

const CONFIGS: Record<ThirdPartyProviderId, ThirdPartyGeocoderConfig> = {
  mapbox: {
    provider: "mapbox",
    endpoint: "https://api.mapbox.com",
    apiKey: "pk.test_fuzz_key",
  },
  nominatim: {
    provider: "nominatim",
    endpoint: "https://nominatim.openstreetmap.org",
  },
  photon: {
    provider: "photon",
    endpoint: "https://photon.komoot.io",
  },
};

const latLonArb = fc.record({
  lat: fc.double({ min: -85, max: 85, noNaN: true }),
  lon: fc.double({ min: -180, max: 180, noNaN: true }),
});

function maxAllowedDecimalPlaces(gridMeters: number): number {
  const gridDeg = gridMeters / EARTH_LAT_METERS_PER_DEG;
  return -Math.floor(Math.log10(gridDeg)) + 1;
}

function assertMaxDecimalPlaces(text: string, gridMeters: number): void {
  const maxDec = maxAllowedDecimalPlaces(gridMeters);
  for (const match of text.matchAll(FLOAT_RE)) {
    const floatStr = match[0]!;
    const dot = floatStr.indexOf(".");
    const decimals = floatStr.length - dot - 1;
    if (decimals > maxDec) {
      throw new Error(
        `Float "${floatStr}" has ${decimals} decimals (max ${maxDec} for ${gridMeters}m grid)`,
      );
    }
  }
}

describe("M10 adapter-boundary precision fuzz", () => {
  beforeEach(() => {
    _resetSessionJitter();
  });

  test("PrecisionLeakError never fires on legitimate coarsen->build->assert path", () => {
    fc.assert(
      fc.property(latLonArb, (raw) => {
        for (const provider of PROVIDERS) {
          for (const gridMeters of GRID_SIZES) {
            const coarsened = coarsen(raw, gridMeters);

            const fwdUrl = buildForwardUrl(
              CONFIGS[provider],
              "fuzz query",
              coarsened,
              gridMeters,
            );
            assertNoPrecisionLeak(fwdUrl, null, gridMeters);

            const revUrl = buildReverseUrl(
              CONFIGS[provider],
              coarsened,
              gridMeters,
            );
            assertNoPrecisionLeak(revUrl, null, gridMeters);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });

  test("outbound floats never exceed grid-floor decimal places", () => {
    fc.assert(
      fc.property(latLonArb, (raw) => {
        for (const provider of PROVIDERS) {
          for (const gridMeters of GRID_SIZES) {
            const coarsened = coarsen(raw, gridMeters);

            const fwdUrl = buildForwardUrl(
              CONFIGS[provider],
              "fuzz query",
              coarsened,
              gridMeters,
            );
            assertMaxDecimalPlaces(fwdUrl, gridMeters);

            const revUrl = buildReverseUrl(
              CONFIGS[provider],
              coarsened,
              gridMeters,
            );
            assertMaxDecimalPlaces(revUrl, gridMeters);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });
});
