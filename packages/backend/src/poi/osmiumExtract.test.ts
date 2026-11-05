import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  categorize,
  extractPoint,
  extractTargetsFromPbf,
  filterFeatures,
  matchCategory,
  runOsmiumExport,
  type CategorizedOsmFeature,
  type OsmFeature,
} from "./osmiumExtract.js";
import { loadTagSpec } from "./osmTags.js";
import {
  fixtureExpectedLooseCounts,
  fixtureExpectedStrictCounts,
  fixtureFeatures,
} from "./__fixtures__/osmFixture.js";

const spec = loadTagSpec();

function pointInRing(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function insidePolygon(px: number, py: number, rings: number[][][]): boolean {
  if (!pointInRing(px, py, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(px, py, rings[i])) return false;
  }
  return true;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("matchCategory", () => {
  it("requires a present name when name_required is set", () => {
    const cat = spec.strict.transit_entrance;
    expect(matchCategory({ railway: "station", name: "X" }, cat)).toBe(true);
    expect(matchCategory({ railway: "station" }, cat)).toBe(false);
    expect(matchCategory({ railway: "station", name: "" }, cat)).toBe(false);
  });

  it("fails closed when no include-rule matches", () => {
    const cat = spec.strict.transit_entrance;
    expect(matchCategory({ amenity: "restaurant", name: "Kafe" }, cat)).toBe(false);
  });

  it("excludes via exclude-rules even if include matches", () => {
    // railway=station would match, but public_transport=platform is in the
    // exclusion list for transit_entrance.
    const cat = spec.strict.transit_entrance;
    expect(
      matchCategory(
        { railway: "station", public_transport: "platform", name: "X" },
        cat
      )
    ).toBe(false);
  });

  it("handles pipe-separated values in rules", () => {
    // aerodrome:type with multiple options
    const cat = spec.strict.public_building;
    expect(
      matchCategory(
        {
          aeroway: "aerodrome",
          "aerodrome:type": "regional",
          name: "Regional Airport",
        },
        cat
      )
    ).toBe(true);
    expect(
      matchCategory(
        {
          aeroway: "aerodrome",
          "aerodrome:type": "private",
          name: "Private Strip",
        },
        cat
      )
    ).toBe(false);
  });

  it("handles the wildcard predicate (key=*)", () => {
    const cat = spec.loose.tourism;
    expect(matchCategory({ tourism: "hotel", name: "Hotel A" }, cat)).toBe(true);
    expect(matchCategory({ tourism: "", name: "Nothing" }, cat)).toBe(false);
  });
});

describe("categorize", () => {
  it("returns the first matching category in iteration order", () => {
    // place=square only matches named_square (not named_junction).
    const tags = { place: "square", name: "Targ" };
    expect(categorize(tags, spec.strict)).toBe("named_square");
  });

  it("returns null for features that match nothing", () => {
    expect(categorize({ natural: "tree" }, spec.strict)).toBeNull();
    expect(categorize({ building: "house" }, spec.loose)).toBeNull();
  });

  it("classifies a hospital as public_building", () => {
    expect(
      categorize({ amenity: "hospital", name: "X" }, spec.strict)
    ).toBe("public_building");
  });

  it("does not classify a clinic (excluded)", () => {
    expect(
      categorize({ amenity: "clinic", name: "Przychodnia" }, spec.strict)
    ).toBeNull();
  });
});

describe("filterFeatures — strict tier", () => {
  it("produces the expected per-category counts on the 100-entry fixture", async () => {
    const results = await collect(filterFeatures(fixtureFeatures, spec, "strict"));
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.category] = (counts[r.category] ?? 0) + 1;

    expect(counts).toEqual(fixtureExpectedStrictCounts);
    const totalExpected = Object.values(fixtureExpectedStrictCounts).reduce(
      (a, b) => a + b,
      0
    );
    expect(results).toHaveLength(totalExpected);
  });

  it("tags every emitted feature with tier='strict' and a known category", async () => {
    const results = await collect(filterFeatures(fixtureFeatures, spec, "strict"));
    const allowed = new Set(Object.keys(spec.strict));
    for (const r of results) {
      expect(r.tier).toBe("strict");
      expect(allowed.has(r.category)).toBe(true);
    }
  });

  it("drops features outside the bbox", async () => {
    // Shift one feature well outside the test bbox.
    const outside: OsmFeature = {
      id: "far",
      type: "node",
      lat: 0,
      lon: 0,
      tags: { railway: "station", name: "Antipode" },
    };
    const input = [...fixtureFeatures, outside];
    const bbox = { minLon: 18, minLat: 54, maxLon: 19, maxLat: 55 };
    const results = await collect(filterFeatures(input, spec, "strict", { bbox }));
    const ids = new Set(results.map((r) => r.id));
    expect(ids.has("far")).toBe(false);
  });
});

describe("filterFeatures — loose tier", () => {
  it("produces the expected per-category counts", async () => {
    const results = await collect(filterFeatures(fixtureFeatures, spec, "loose"));
    const counts: Record<string, number> = {};
    for (const r of results) counts[r.category] = (counts[r.category] ?? 0) + 1;
    expect(counts).toEqual(fixtureExpectedLooseCounts);
  });

  it("excludes tourism=information even with name", async () => {
    const results = await collect(filterFeatures(fixtureFeatures, spec, "loose"));
    const touristInfo = results.filter(
      (r: CategorizedOsmFeature) => r.tags.tourism === "information"
    );
    expect(touristInfo).toHaveLength(0);
  });

  it("excludes named viewpoints", async () => {
    const results = await collect(filterFeatures(fixtureFeatures, spec, "loose"));
    expect(results.filter((r: CategorizedOsmFeature) => r.tags.tourism === "viewpoint")).toHaveLength(0);
  });
});

describe("extractPoint", () => {
  it("returns coordinates for a Point geometry", () => {
    expect(extractPoint({ type: "Point", coordinates: [18.64, 54.35] }))
      .toEqual([18.64, 54.35]);
  });

  it("computes proper centroid for a symmetric Polygon", () => {
    const square = [
      [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
    ];
    const [lon, lat] = extractPoint({ type: "Polygon", coordinates: [square] });
    expect(lon).toBeCloseTo(5, 5);
    expect(lat).toBeCloseTo(5, 5);
  });

  it("computes centroid correctly for a Polygon with uneven vertex density", () => {
    const ring = [
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0],
      [10, 10], [0, 10], [0, 0],
    ];
    const [lon, lat] = extractPoint({ type: "Polygon", coordinates: [ring] });
    expect(lon).toBeCloseTo(5, 1);
    expect(lat).toBeCloseTo(5, 1);
  });

  it("avoids placing point inside symmetric courtyard hole", () => {
    const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
    const hole = [[5, 5], [5, 15], [15, 15], [15, 5], [5, 5]];
    const [lon, lat] = extractPoint({ type: "Polygon", coordinates: [outer, hole] });
    expect(lon).not.toBeNull();
    expect(lat).not.toBeNull();
    expect(insidePolygon(lon!, lat!, [outer, hole])).toBe(true);
  });

  it("returns interior point for concave single-ring polygon", () => {
    const uShape = [[0,0],[10,0],[10,10],[7,10],[7,3],[3,3],[3,10],[0,10],[0,0]];
    const [lon, lat] = extractPoint({ type: "Polygon", coordinates: [uShape] });
    expect(lon).not.toBeNull();
    expect(lat).not.toBeNull();
    expect(insidePolygon(lon!, lat!, [uShape])).toBe(true);
  });

  it("shifts centroid away from hole in Polygon with interior ring", () => {
    const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
    const hole = [[1, 1], [1, 10], [10, 10], [10, 1], [1, 1]];
    const [lon, lat] = extractPoint({ type: "Polygon", coordinates: [outer, hole] });
    expect(lon).toBeGreaterThan(10);
    expect(lat).toBeGreaterThan(10);
  });

  it("computes centroid for a MultiPolygon", () => {
    const poly1 = [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]];
    const poly2 = [[[8, 8], [10, 8], [10, 10], [8, 10], [8, 8]]];
    const [lon, lat] = extractPoint({ type: "MultiPolygon", coordinates: [poly1, poly2] });
    const inPoly1 = insidePolygon(lon!, lat!, poly1);
    const inPoly2 = insidePolygon(lon!, lat!, poly2);
    expect(inPoly1 || inPoly2).toBe(true);
  });

  it("shifts centroid for MultiPolygon with holes", () => {
    const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
    const hole = [[5, 5], [5, 15], [15, 15], [15, 5], [5, 5]];
    const polyWithHole = [outer, hole];
    const rect = [[[25, 5], [35, 5], [35, 15], [25, 15], [25, 5]]];
    const [lon, lat] = extractPoint({ type: "MultiPolygon", coordinates: [polyWithHole, rect] });
    expect(lon).not.toBeNull();
    expect(lat).not.toBeNull();
    const inHole = lon! >= 5 && lon! <= 15 && lat! >= 5 && lat! <= 15;
    expect(inHole).toBe(false);
    const inOuter = lon! >= 0 && lon! <= 20 && lat! >= 0 && lat! <= 20;
    const inRect = lon! >= 25 && lon! <= 35 && lat! >= 5 && lat! <= 15;
    expect(inOuter || inRect).toBe(true);
  });

  it("falls back to vertex average for LineString", () => {
    const [lon, lat] = extractPoint({ type: "LineString", coordinates: [[0, 0], [10, 10]] });
    expect(lon).toBeCloseTo(5, 5);
    expect(lat).toBeCloseTo(5, 5);
  });
});

/**
 * Smoke test for the osmium subprocess wrapper. Only runs when `osmium` is on
 * PATH; otherwise skipped. CI installs osmium-tool and has its own e2e coverage
 * via the bundle-build job.
 */
const hasOsmium = (() => {
  try {
    const r = spawnSync("osmium", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOsmium)("runOsmiumExport (integration)", () => {
  it("is available — placeholder until fixture PBF is generated in CI", () => {
    // CI job `build-poi-bundles` is responsible for generating a sample PBF
    // and asserting round-trip counts. Keeping this block in place so the
    // suite lights up automatically once osmium is on PATH locally.
    expect(hasOsmium).toBe(true);
  });

  it("reports the real OSM type for a node vs a way", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmium-type-test-"));
    const fixturePath = join(dir, "fixture.osm");
    try {
      await writeFile(
        fixturePath,
        `<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <node id="1" lat="54.6872" lon="25.2797" version="1">
    <tag k="addr:housenumber" v="9"/>
    <tag k="addr:street" v="Gedimino pr."/>
  </node>
  <node id="2" lat="54.6900" lon="25.2800" version="1"/>
  <node id="3" lat="54.6905" lon="25.2805" version="1"/>
  <node id="4" lat="54.6903" lon="25.2810" version="1"/>
  <way id="10" version="1">
    <nd ref="2"/>
    <nd ref="3"/>
    <nd ref="4"/>
    <nd ref="2"/>
    <tag k="building" v="yes"/>
    <tag k="addr:housenumber" v="15"/>
    <tag k="addr:street" v="Pilies g."/>
  </way>
</osm>
`,
      );

      const features: OsmFeature[] = [];
      for await (const f of runOsmiumExport(fixturePath)) features.push(f);

      const nodeFeature = features.find((f) => f.tags["addr:housenumber"] === "9");
      const wayFeature = features.find((f) => f.tags["addr:housenumber"] === "15");

      expect(nodeFeature?.type).toBe("node");
      expect(wayFeature?.type).toBe("way");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runOsmiumExport child lifecycle", () => {
  it("waits for the export process exit after stdout drains", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmium-lifecycle-test-"));
    const fakeBin = join(dir, "fake-osmium.mjs");
    try {
      await writeFile(
        fakeBin,
        `#!/usr/bin/env node
if (process.argv[2] !== "export") process.exit(2);
const feature = {
  type: "Feature",
  id: "node/1",
  properties: { "@type": "node", "@id": 1, name: "Fixture" },
  geometry: { type: "Point", coordinates: [25.2797, 54.6872] },
};
process.stdout.write("\\x1e" + JSON.stringify(feature) + "\\n");
process.stdout.end();
setTimeout(() => process.exit(0), 50);
`,
      );
      await chmod(fakeBin, 0o755);

      const features = await collect(runOsmiumExport("unused.osm", { osmiumBin: fakeBin }));

      expect(features).toHaveLength(1);
      expect(features[0]?.id).toBe("1");
      expect(features[0]?.type).toBe("node");
      expect(features[0]?.tags.name).toBe("Fixture");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A stand-in osmium that only answers `export`. Any other subcommand (such as
 * `extract`, whose ID bitsets cost ~2-4 GB on a regional file) exits 2, so a
 * test fails if the wrapper starts shelling out to it again.
 */
async function fakeOsmium(
  dir: string,
  features: Array<{ id: number; lon: number; lat: number; tags: Record<string, string> }>,
  exit = "process.exit(0)",
): Promise<string> {
  const bin = join(dir, "fake-osmium.mjs");
  const lines = features.map((f) =>
    JSON.stringify({
      type: "Feature",
      properties: { "@type": "node", "@id": f.id, ...f.tags },
      geometry: { type: "Point", coordinates: [f.lon, f.lat] },
    }),
  );
  await writeFile(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] !== "export") process.exit(2);
for (const l of ${JSON.stringify(lines)}) process.stdout.write("\\x1e" + l + "\\n");
process.stdout.end();
setTimeout(() => { ${exit}; }, 20);
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

const HOSPITAL = { amenity: "hospital", name: "H" };
const HOTEL = { tourism: "hotel", name: "Hotel" };
const GDANSK = { minLon: 18.4, minLat: 54.28, maxLon: 18.95, maxLat: 54.45 };
const VILNIUS = { minLon: 25.1, minLat: 54.6, maxLon: 25.45, maxLat: 54.8 };

describe("runOsmiumExport bbox", () => {
  it("keeps features by point without running osmium extract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmium-bbox-test-"));
    try {
      const bin = await fakeOsmium(dir, [
        { id: 1, lon: 18.6, lat: 54.35, tags: HOSPITAL },
        { id: 2, lon: 25.28, lat: 54.69, tags: HOSPITAL },
      ]);
      const features = await collect(
        runOsmiumExport("region.osm.pbf", { osmiumBin: bin, bbox: GDANSK }),
      );
      expect(features.map((f) => f.id)).toEqual(["1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names the signal when osmium is killed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmium-signal-test-"));
    try {
      const bin = await fakeOsmium(dir, [], 'process.kill(process.pid, "SIGKILL")');
      await expect(collect(runOsmiumExport("region.osm.pbf", { osmiumBin: bin }))).rejects.toThrow(
        "osmium export exited with signal SIGKILL",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extractTargetsFromPbf", () => {
  it("sorts one export pass into every (bbox, tier) target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osmium-targets-test-"));
    try {
      const bin = await fakeOsmium(dir, [
        { id: 1, lon: 18.6, lat: 54.35, tags: HOSPITAL },
        { id: 2, lon: 18.61, lat: 54.36, tags: HOTEL },
        { id: 3, lon: 25.28, lat: 54.69, tags: HOSPITAL },
        { id: 4, lon: 10, lat: 10, tags: HOSPITAL },
        { id: 5, lon: 18.61, lat: 54.36, tags: { name: "Museum", tourism: "museum" } },
        { id: 6, lon: 18.61, lat: 54.36, tags: { name: "Arts", amenity: "arts_centre", tourism: "attraction" } },
      ]);
      const byTarget = await extractTargetsFromPbf(
        "region.osm.pbf",
        spec,
        [
          { key: "gdansk/strict", bbox: GDANSK, tier: "strict" },
          { key: "gdansk/loose", bbox: GDANSK, tier: "loose" },
          { key: "vilnius/strict", bbox: VILNIUS, tier: "strict" },
          { key: "empty/strict", bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, tier: "strict" },
        ],
        { osmiumBin: bin },
      );
      const ids = (k: string) => byTarget.get(k)?.map((f) => `${f.id}:${f.tier}:${f.category}`);
      expect(ids("gdansk/strict")).toEqual(["1:strict:public_building", "5:strict:culture", "6:strict:culture"]);
      expect(ids("gdansk/loose")).toEqual(["2:loose:tourism"]);
      expect(ids("vilnius/strict")).toEqual(["3:strict:public_building"]);
      expect(ids("empty/strict")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe("destination-quality strict expansion", () => {
  it.each([
    [{ tourism: "museum" }, "culture"],
    [{ amenity: "theatre" }, "culture"],
    [{ amenity: "cinema" }, "culture"],
    [{ amenity: "arts_centre" }, "culture"],
    [{ amenity: "library" }, "civic"],
    [{ amenity: "townhall" }, "civic"],
    [{ amenity: "community_centre" }, "civic"],
    [{ leisure: "stadium" }, "recreation"],
    [{ leisure: "sports_centre" }, "recreation"],
    [{ leisure: "water_park" }, "recreation"],
    [{ leisure: "park" }, "outdoor"],
    [{ leisure: "garden" }, "outdoor"],
    [{ natural: "beach" }, "outdoor"],
    [{ shop: "mall" }, "mall"],
  ])("includes named %j, but excludes its unnamed counterpart", (tags, category) => {
    expect(categorize({ ...tags, name: "Destination" }, spec.strict)).toBe(category);
    expect(categorize(tags, spec.strict)).toBeNull();
  });

  it.each<Record<string, string>>([
    { leisure: "pitch", name: "Court 1" },
    { leisure: "garden", access: "private", name: "Home garden" },
    { leisure: "garden", "garden:type": "residential", name: "Home garden" },
    { leisure: "park", access: "no", name: "Closed park" },
    { leisure: "sports_centre", access: "private", name: "Private gym" },
    { shop: "supermarket", name: "Store" },
    { amenity: "kindergarten", name: "Nursery" },
    { tourism: "hotel", name: "Hotel" },
  ])("does not promote granular/private/loose %j", (tags) => {
    expect(categorize(tags, spec.strict)).toBeNull();
  });

  it("keeps strict multi-tag venues out of loose results", async () => {
    const features: OsmFeature[] = [
      { id: "1", type: "node", lat: 54.44, lon: 18.56, tags: { name: "Museum", tourism: "museum" } },
      { id: "2", type: "node", lat: 54.44, lon: 18.56, tags: { name: "Venue", amenity: "arts_centre", tourism: "attraction" } },
      { id: "3", type: "node", lat: 54.44, lon: 18.56, tags: { name: "School", amenity: "school" } },
      { id: "4", type: "node", lat: 54.44, lon: 18.56, tags: { name: "Nursery", amenity: "kindergarten" } },
    ];
    expect((await collect(filterFeatures(features, spec, "strict"))).map((f) => f.id)).toEqual(["1", "2"]);
    expect((await collect(filterFeatures(features, spec, "loose"))).map((f) => [f.id, f.category]))
      .toEqual([["3", "school"], ["4", "kindergarten"]]);
  });
});
