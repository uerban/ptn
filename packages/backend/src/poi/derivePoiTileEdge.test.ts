import { describe, it, expect } from "vitest";
import type { PoiEntry } from "@pt/shared";
import { TILE_MIN_K } from "@pt/shared";
import { derivePoiTileEdge, KANON_LADDER } from "./derivePoiTileEdge.js";

const BBOX = { minLon: 18.4, minLat: 54.28, maxLon: 18.75, maxLat: 54.45 };
const EXPECTED_ANCHOR = { minLat: 54.28, minLon: 18.4, refLat: (54.28 + 54.45) / 2 };

function cluster(n: number, lat = 54.35, lon = 18.6): PoiEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`, name: `E${i}`, aliases: {}, category: "landmark",
    lat: lat + i * 1e-6, lon: lon + i * 1e-6,
    source: "osm" as const, rankBoost: 0.3, tier: "strict" as const,
  }));
}

describe("derivePoiTileEdge", () => {
  it("k-anon-floor: smallest ladder edge with every tile >= k; correct anchor", () => {
    const r = derivePoiTileEdge(cluster(60), "k-anon-floor", BBOX, {});
    expect(KANON_LADDER).toContain(r.edgeKm);
    expect(r.edgeKm).toBe(12); // one dense cluster passes at the finest edge
    expect(r.kAnonWaived).toBe(false);
    expect(r.anchor).toEqual(EXPECTED_ANCHOR);
  });

  it("k-anon-floor: coarsens past the finest edge for two far sub-k clusters", () => {
    const entries = [...cluster(30, 54.30, 18.42), ...cluster(30, 54.44, 18.73)];
    const r = derivePoiTileEdge(entries, "k-anon-floor", BBOX, {});
    expect(r.edgeKm).toBeGreaterThan(12); // 12km separates them into two 30s (<50)
  });

  it("k-anon-floor: whole-bbox fallback yields exactly one tile when no ladder edge passes", () => {
    // Two 40-clusters far apart never both reach 50 at any ladder edge < bbox span,
    // and 40+40=80 only meets k as a single tile → fallback edge.
    const entries = [...cluster(40, 54.29, 18.41), ...cluster(40, 54.44, 18.74)];
    const r = derivePoiTileEdge(entries, "k-anon-floor", BBOX, {});
    const byTile = new Set(entries.map((e) =>
      // origin-relative single-tile check
      Math.floor((e.lat - r.anchor.minLat) / (r.edgeKm / 111.32)) + "_" +
      Math.floor((e.lon - r.anchor.minLon) / (r.edgeKm / (111.32 * Math.cos(r.anchor.refLat * Math.PI / 180))))));
    expect(byTile.size).toBe(1);
  });

  it("fixed-edge: passes the operator edge, waives k", () => {
    const r = derivePoiTileEdge(cluster(10), "fixed-edge", BBOX, { fixedEdgeKm: 6 });
    expect(r).toMatchObject({ edgeKm: 6, kAnonWaived: true });
  });

  it("byte-budget: waives k, every tile <= cap, edge is the LARGEST passing", () => {
    const r = derivePoiTileEdge(cluster(200), "byte-budget", BBOX, { maxBytes: 65536 });
    expect(r.kAnonWaived).toBe(true);
    expect(r.edgeKm).toBeGreaterThan(0);
  });

  it("byte-budget: empty entries returns a valid edge (no throw)", () => {
    expect(() => derivePoiTileEdge([], "byte-budget", BBOX, { maxBytes: 1024 })).not.toThrow();
  });

  it("deterministic: same inputs → same output", () => {
    const e = cluster(120);
    expect(derivePoiTileEdge(e, "k-anon-floor", BBOX, {}))
      .toEqual(derivePoiTileEdge(e, "k-anon-floor", BBOX, {}));
  });

  it("k-anon-floor: throws for a city with < k total POIs", () => {
    expect(() => derivePoiTileEdge(cluster(49), "k-anon-floor", BBOX, {}))
      .toThrow(/< ?k|below k|cannot satisfy/i);
  });
});
