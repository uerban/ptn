import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  POI_MANIFEST_SCHEMA_VERSION,
  type LandmarkCityId,
  type PoiManifest,
  type PoiManifestBundle,
  type PoiTileManifest,
} from "@pt/shared";

export type { PoiTileManifest };
export { POI_MANIFEST_SCHEMA_VERSION };

/** Build-side bundle entry: the shared reader shape with writer-required fields
 *  pinned (cityId narrowed to LandmarkCityId; sha256 added by writeManifest). */
export interface BundleEntry extends Omit<PoiManifestBundle, "cityId" | "sha256"> {
  cityId: LandmarkCityId;
}

export interface ManifestBundle extends BundleEntry {
  readonly sha256: string;
}

export interface Manifest extends PoiManifest {
  readonly schemaVersion: number;
  readonly generatedAt: number;
  readonly bundles: readonly ManifestBundle[];
}

/**
 * Write `manifest.json` next to the bundle artifacts.
 *
 * Precondition: every `entries[i].filename` must already exist on disk under
 * `outputDir`. Each bundle is read back, hashed (sha256), and recorded in
 * the manifest. Caller is responsible for the filesystem ordering — write
 * bundles first, then call this.
 *
 * Output ordering is stable: bundles sort by `(cityId, filename)` so a new
 * city inserted into `CITY_PROFILES` produces a localised diff rather than
 * a wholesale shuffle.
 *
 * @param outputDir directory holding bundle files; manifest is written here
 * @param entries the bundle metadata produced during the build
 * @param now injected clock; defaults to `Date.now`. Useful for tests
 *            that assert on `generatedAt`.
 * @returns the in-memory `Manifest` that was just written, so callers /
 *          tests can assert without re-reading from disk.
 */
export function writeManifest(
  outputDir: string,
  entries: BundleEntry[],
  now: () => number = Date.now,
): Manifest {
  const bundles: ManifestBundle[] = entries
    .map((e) => {
      const bundlePath = join(outputDir, e.filename);
      let buf: Buffer;
      try {
        buf = readFileSync(bundlePath);
      } catch (err) {
        throw new Error(
          `writeManifest: failed to hash bundle ${e.cityId} (${bundlePath}). ` +
            `Bundle file missing or unreadable — check that the build wrote ` +
            `it before manifest emission.`,
          { cause: err },
        );
      }
      const sha256 = createHash("sha256").update(buf).digest("hex");
      return { ...e, sha256, ...(e.poiTile ? { poiTile: e.poiTile } : {}) };
    })
    .sort(
      (a, b) =>
        a.cityId.localeCompare(b.cityId) || a.filename.localeCompare(b.filename),
    );

  const manifest: Manifest = { schemaVersion: POI_MANIFEST_SCHEMA_VERSION, generatedAt: now(), bundles };
  writeFileSync(
    join(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
