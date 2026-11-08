import type {GtfsShapeRecord} from "../db/index.ts";
import {fetchSharedArtifactBytes} from "./sharedCityArtifacts.ts";

/** Only the active consumer decodes shape rows. Inactive city geometry remains
 * verified raw JSON bytes, shared by its content hash. */
export async function fetchCityShapes(url: string, hash: string, opts: {signal?: AbortSignal} = {}): Promise<GtfsShapeRecord[]> {
  const bytes = await fetchSharedArtifactBytes("shapes", url, hash, opts);
  const body = JSON.parse(new TextDecoder().decode(bytes)) as {shapes?: unknown};
  if (!Array.isArray(body.shapes)) throw new Error("Invalid shapes artifact");
  return body.shapes.map((row: {shapeId?: unknown; encodedPolyline?: unknown}) => {
    if (typeof row.shapeId !== "string" || typeof row.encodedPolyline !== "string") throw new Error("Invalid shapes artifact row");
    return {shapeId: row.shapeId, encodedPolyline: row.encodedPolyline, source: "gtfs"};
  });
}
