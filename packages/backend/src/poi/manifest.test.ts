import { describe, it, expect } from "vitest";
import { POI_MANIFEST_SCHEMA_VERSION, type ManifestBundle } from "./manifest.js";

describe("POI manifest schema", () => {
  it("exposes schemaVersion 1", () => { expect(POI_MANIFEST_SCHEMA_VERSION).toBe(1); });
  it("ManifestBundle carries an optional poiTile block (type-level)", () => {
    const b: ManifestBundle = {
      cityId: "gdansk", filename: "gdansk.br", sizeBytes: 1, sha256: "ab",
      poiTile: {
        edgeKm: 24,
        anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
        tileBounds: { minX: -1, maxX: 2, minY: -1, maxY: 2 },
        tilingPolicy: "k-anon-floor",
        kAnonWaived: false,
        deliveryActive: true,
      },
    };
    expect(b.poiTile?.edgeKm).toBe(24);
  });
});
