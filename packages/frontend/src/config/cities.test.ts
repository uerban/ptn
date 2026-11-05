import { describe, it, expect } from "vitest";
import { CITIES, type CityConfig, type SharedMobilitySystem } from "./cities.ts";

describe("CityConfig.poiFetchMode field", () => {
  it("the field is optional and assignable to the PoiFetchMode union", () => {
    // Compile-time proof: a CityConfig literal accepts a valid poiFetchMode and
    // omitting it is legal. (Runtime assertion keeps the test non-empty.)
    const withMode: CityConfig = {
      id: "x", name: "X",
      center: { lat: 0, lon: 0 },
      bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
      available: false,
      tz: "Europe/Vilnius",
      poiFetchMode: "lazy-tile",
    };
    const withoutMode: CityConfig = {
      id: "y", name: "Y",
      center: { lat: 0, lon: 0 },
      bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
      available: false,
      tz: "Europe/Vilnius",
    };
    expect(withMode.poiFetchMode).toBe("lazy-tile");
    expect(withoutMode.poiFetchMode).toBeUndefined();
  });

  it("vilnius + tricity (and ONLY those) carry poiFetchMode after full activation", () => {
    // Full POI-footprint activation: both POI-bearing frontend cities are
    // lazy-tile; the non-POI cities (krakow/paris/oslo) stay unset.
    // Order-pinned to the live CITIES order (vilnius index 0, tricity index 1) —
    // a missed or extra city fails this exact set-equality guard.
    expect(CITIES.filter((c) => c.poiFetchMode !== undefined).map((c) => c.id)).toEqual(["vilnius", "tricity"]);
    expect(CITIES.find((c) => c.id === "vilnius")?.poiFetchMode).toBe("lazy-tile");
    expect(CITIES.find((c) => c.id === "tricity")?.poiFetchMode).toBe("lazy-tile");
  });
});

describe("CityConfig.sharedMobility field (GBFS bike-share layer)", () => {
  it("the field is optional; cities without it stay valid", () => {
    // Compile-time proof: a CityConfig literal accepts a sharedMobility array
    // and omitting it is legal. (Runtime assertion keeps the test non-empty.)
    const system: SharedMobilitySystem = {
      id: "op",
      name: "Operator",
      gbfsDiscoveryUrl: "https://example.com/gbfs/gbfs.json",
    };
    const withSystems: CityConfig = {
      id: "x", name: "X",
      center: { lat: 0, lon: 0 },
      bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
      available: false,
      tz: "Europe/Vilnius",
      sharedMobility: [system],
    };
    const withoutSystems: CityConfig = {
      id: "y", name: "Y",
      center: { lat: 0, lon: 0 },
      bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
      available: false,
      tz: "Europe/Vilnius",
    };
    expect(withSystems.sharedMobility).toHaveLength(1);
    expect(withoutSystems.sharedMobility).toBeUndefined();
  });

  it("vilnius (and ONLY vilnius, for now) carries exactly one entry: cyclocity", () => {
    // PoC scope pin: adding an operator to another city must consciously
    // extend this set-equality guard, like the poiFetchMode guard above.
    expect(CITIES.filter((c) => c.sharedMobility !== undefined).map((c) => c.id)).toEqual(["vilnius"]);
    const vilnius = CITIES.find((c) => c.id === "vilnius");
    expect(vilnius?.sharedMobility).toHaveLength(1);
    const cyclocity = vilnius?.sharedMobility?.[0];
    expect(cyclocity?.id).toBe("cyclocity");
    expect(cyclocity?.gbfsDiscoveryUrl).toMatch(/^https:\/\//);
  });

  it("every configured entry has a non-empty id/name and an https discovery URL", () => {
    // Privacy + integrity floor for ALL operators, current and future: the
    // client fetches these third-party URLs directly, so plaintext http (or a
    // blank identity) must never ship in config.
    for (const city of CITIES) {
      for (const system of city.sharedMobility ?? []) {
        expect(system.id, `${city.id}: system id`).toBeTruthy();
        expect(system.name, `${city.id}/${system.id}: system name`).toBeTruthy();
        expect(
          system.gbfsDiscoveryUrl,
          `${city.id}/${system.id}: discovery URL must be https`,
        ).toMatch(/^https:\/\/\S+$/);
      }
    }
  });
});
