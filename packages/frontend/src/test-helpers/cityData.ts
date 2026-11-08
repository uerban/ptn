import { db } from "../db/index.ts";

/** Legacy-table fixtures must declare their city, just as a completed sync does. */
export async function seedLegacyCityProjection(cityId = "vilnius"): Promise<void> {
  await db.gtfsSyncMeta.put({id: "current", cityId, generationId: "fixture-generation", etag: "fixture-etag",
    generatedAt: "2026-11-07T00:00:00Z", lastSynced: Date.now()});
}
