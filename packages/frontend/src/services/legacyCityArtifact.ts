import {db, type GtfsSyncMeta, type PtbBytesRecord, type GtfsBundleRecord} from "../db/index.ts";
import {decodeGzipJson, type RaptorBundleWire} from "./gtfsBundle.ts";
import {prepareCityArtifact} from "./cityArtifacts.ts";
import {canonicalCityId} from "../utils/cityId.ts";

/** Lazy, selected-city compatibility read. Never restores global projections or
 * enumerates another city's package payload. Original rows remain recoverable. */
export async function readLegacyCityArtifact(cityId: string, preferDownload: boolean) {
  cityId = canonicalCityId(cityId);
  const snapshot = await db.transaction("r", [db.offlineCities, db.gtfsSyncMeta, db.ptbBytes, db.gtfsBundle], async () => {
    const saved = preferDownload ? await db.offlineCities.get(cityId) : undefined;
    if (saved) return {
      meta: saved.tables.gtfsSyncMeta?.[0] as GtfsSyncMeta | undefined,
      ptb: saved.tables.ptbBytes?.find(row => canonicalCityId((row as PtbBytesRecord).cityId) === cityId) as PtbBytesRecord | undefined,
      bundle: saved.tables.gtfsBundle?.find(row => canonicalCityId((row as GtfsBundleRecord).cityId) === cityId) as GtfsBundleRecord | undefined,
    };
    const [meta, ptb, bundle] = await Promise.all([
      db.gtfsSyncMeta.get("current"), db.ptbBytes.get(cityId), db.gtfsBundle.get(cityId),
    ]);
    return {meta, ptb, bundle};
  });
  const {meta, ptb, bundle} = snapshot;
  if (!meta || canonicalCityId(meta.cityId) !== cityId || !ptb?.bytes.byteLength ||
      !bundle || bundle.format !== "gzip" || ptb.etag !== meta.etag) return undefined;
  const wire = await decodeGzipJson<RaptorBundleWire>(bundle.compressedBytes);
  if (wire.meta.cityId && canonicalCityId(wire.meta.cityId) !== cityId) return undefined;
  const tz = ptb.cityTzIana ?? wire.meta.cityTzIana;
  const transfers = ptb.transfersArtifact ?? wire.meta.transfersArtifact;
  if (!tz || (wire.meta.cityTzIana && wire.meta.cityTzIana !== tz) ||
      (ptb.transfersArtifact && wire.meta.transfersArtifact && ptb.transfersArtifact.hash !== wire.meta.transfersArtifact.hash) ||
      (meta.transfersHash && meta.transfersHash !== transfers?.hash) ||
      (meta.shapesHash && meta.shapesHash !== wire.meta.shapesArtifact?.hash)) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(ptb.bytes));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  // Older servers used a truncated content ETag. Verify that legacy contract,
  // then use the full content identity within the new immutable store only.
  if (ptb.etag !== `"${hash}"` && ptb.etag !== `"${hash.slice(0, 32)}"`) return undefined;
  return prepareCityArtifact(cityId, {
    generationId: meta.generationId || hash, bundleSha256: hash,
    generatedAt: meta.generatedAt, cityTzIana: tz,
    ...(wire.meta.shapesArtifact ? {shapesArtifact: wire.meta.shapesArtifact} : {}),
  }, {bytes: ptb.bytes, etag: `"${hash}"`, fromCache: true, networkValidated: false,
    cityTzIana: tz, transfersArtifact: transfers, transfersResolved: true});
}
