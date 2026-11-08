import {db, type GtfsShapeRecord, type GtfsSyncMeta} from "../db/index.ts";
import {type CityDataContext, useCityDataStore} from "./cityData.ts";
import {canonicalCityId} from "../utils/cityId.ts";

/** Recover only the selected generation's old rows after optional raw geometry
 * is unavailable. The original snapshot remains the recovery source until an
 * explicit modern download replaces it; no projections are copied/restored. */
export async function readLegacyCityShapes(context: CityDataContext): Promise<GtfsShapeRecord[]> {
  const current = () => useCityDataStore.getState().active === context;
  if (!current()) return [];
  const cityId = context.token.cityId;
  const matches = (meta: GtfsSyncMeta | undefined) => {
    if (!meta || canonicalCityId(meta.cityId) !== cityId) return false;
    const expectedHash = context.artifact?.generation.bundleSha256;
    const etagMatches = meta.etag === context.meta.etag ||
      (expectedHash && meta.etag === `"${expectedHash.slice(0, 32)}"`);
    const generationMatches = meta.generationId
      ? meta.generationId === context.token.generationId
      : expectedHash === context.token.generationId;
    return !!etagMatches && generationMatches &&
      !(meta.shapesHash && context.meta.shapesHash && meta.shapesHash !== context.meta.shapesHash);
  };
  const rows = await db.transaction("r", [db.offlineCities, db.gtfsSyncMeta, db.gtfsShapes], () =>
    db.offlineCities.get(cityId).then(saved => {
      const meta = saved?.tables.gtfsSyncMeta?.[0] as GtfsSyncMeta | undefined;
      if (matches(meta)) return (saved?.tables.gtfsShapes ?? []) as GtfsShapeRecord[];
      return db.gtfsSyncMeta.get("current").then(meta => matches(meta) ? db.gtfsShapes.toArray() : []);
    }));
  if (!current()) return [];
  return rows.filter(row => row && typeof row.shapeId === "string" && typeof row.encodedPolyline === "string")
    .map(row => ({shapeId: row.shapeId, encodedPolyline: row.encodedPolyline, source: "gtfs"}));
}
