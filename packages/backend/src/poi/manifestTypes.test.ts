import { describe, it, expect } from "vitest";
import type {
  PoiManifest,
  PoiManifestBundle,
} from "@pt/shared";
import type { Manifest, ManifestBundle } from "./manifest.js";

describe("backend Manifest assignable to shared reader (AC-20)", () => {
  it("ManifestBundle is assignable to PoiManifestBundle", () => {
    const b: ManifestBundle = {
      cityId: "gdansk",
      filename: "gdansk.br",
      sizeBytes: 1,
      sha256: "ab",
      poiTile: {
        edgeKm: 24,
        anchor: { minLat: 54.28, minLon: 18.4, refLat: 54.365 },
        tileBounds: { minX: -1, maxX: 2, minY: -1, maxY: 2 },
        tilingPolicy: "k-anon-floor",
        kAnonWaived: false,
        deliveryActive: true,
      },
    };
    const reader: PoiManifestBundle = b satisfies PoiManifestBundle;
    expect(reader.poiTile?.edgeKm).toBe(24);
  });

  it("Manifest is assignable to PoiManifest", () => {
    const m: Manifest = { schemaVersion: 1, generatedAt: 123, bundles: [] };
    const reader: PoiManifest = m satisfies PoiManifest;
    expect(reader.schemaVersion).toBe(1);
  });
});
