import { describe, expect, test } from "vitest";
import { micromapToGeoJson } from "./micromapGeoJson.ts";
import { parseMicromapArtifact, type MicromapArtifact } from "./types.ts";

/**
 * A closed square ring from (25.20, 54.70) to (25.21, 54.71), Google-encoded
 * at precision 5 by `scripts/lib/micromap/encode.mjs` — the same encoder the
 * generator uses, so this doubles as a cross-check of the two codecs.
 */
const SQUARE = "_rzlI_{xxC?o}@o}@??n}@n}@?";

/** A two-point line: too few corners to be a ring. */
const OPEN_STUB = "_rzlI_{xxC?o}@";

function artifact(overrides: Partial<MicromapArtifact> = {}): MicromapArtifact {
  return {
    version: 1,
    cityId: "vilnius",
    generatedAt: "2026-08-20",
    attribution: "© OpenStreetMap contributors (ODbL)",
    bbox: [25.15, 54.62, 25.42, 54.75],
    water: [],
    green: [],
    waterways: [],
    roads: [],
    places: [],
    ...overrides,
  };
}

describe("parseMicromapArtifact", () => {
  test("accepts a well-formed artifact", () => {
    const parsed = parseMicromapArtifact(artifact());
    expect(parsed).not.toBeNull();
    expect(parsed?.cityId).toBe("vilnius");
  });

  test("rejects an unknown format version", () => {
    expect(parseMicromapArtifact({ ...artifact(), version: 99 })).toBeNull();
  });

  test("rejects a missing or malformed bbox", () => {
    expect(parseMicromapArtifact({ ...artifact(), bbox: [1, 2] })).toBeNull();
    expect(parseMicromapArtifact({ ...artifact(), bbox: undefined })).toBeNull();
  });

  test("drops malformed entries instead of the whole map", () => {
    const parsed = parseMicromapArtifact({
      ...artifact(),
      roads: [{ c: "primary", g: SQUARE }, { c: "primary" }, null],
      places: [
        { n: "Antakalnis", y: 54.7, x: 25.3, r: 3 },
        { n: "Broken", y: "x", x: 25.3, r: 3 },
      ],
    });
    expect(parsed?.roads).toHaveLength(1);
    expect(parsed?.places).toHaveLength(1);
  });
});

describe("micromapToGeoJson", () => {
  test("emits one source per family with GeoJSON lon/lat order", () => {
    const geo = micromapToGeoJson(
      artifact({
        water: [{ r: [SQUARE] }],
        roads: [{ c: "primary", g: SQUARE }],
        places: [{ n: "Antakalnis", y: 54.7, x: 25.3, r: 3 }],
      }),
    );

    expect(geo.areas.features).toHaveLength(1);
    expect(geo.areas.features[0].properties.kind).toBe("water");
    const ring = geo.areas.features[0].geometry.coordinates[0];
    expect(ring[0][0]).toBeCloseTo(25.2, 3);
    expect(ring[0][1]).toBeCloseTo(54.7, 3);
    expect(ring[0]).toEqual(ring[ring.length - 1]);

    expect(geo.roads.features[0].properties.cls).toBe("primary");
    expect(geo.places.features[0].geometry.coordinates).toEqual([25.3, 54.7]);
    expect(geo.places.features[0].properties).toEqual({
      name: "Antakalnis",
      rank: 3,
    });
  });

  test("draws green areas beneath water", () => {
    const geo = micromapToGeoJson(
      artifact({ water: [{ r: [SQUARE] }], green: [{ r: [SQUARE] }] }),
    );
    expect(geo.areas.features.map((f) => f.properties.kind)).toEqual([
      "green",
      "water",
    ]);
  });

  test("skips rings that decode to fewer than three corners", () => {
    const geo = micromapToGeoJson(artifact({ water: [{ r: [OPEN_STUB] }] }));
    expect(geo.areas.features).toHaveLength(0);
  });
});
