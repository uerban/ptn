import {cityDataWrite} from "./cityDataWrite.ts";
import { measureCityStage } from "./cityPerformance.ts";
import {db, type OfflineCityRecord, type OfflineCityMetadata} from "../db/index.ts";
import type {CityConfig} from "../config/cities.ts";
import {collectCityArtifacts, hasCachedCityArtifact, pinCityArtifact, readCityArtifact} from "./cityArtifacts.ts";
import {useCityDataStore} from "./cityData.ts";
import {canonicalCityId} from "../utils/cityId.ts";

const SNAPSHOT_TABLES = ["gtfsRoutes", "gtfsTrips", "gtfsServices", "gtfsStops", "gtfsShapes", "gtfsSyncMeta", "stopGroups", "gtfsBundle", "ptbBytes"] as const;

function packageMetadata(saved: OfflineCityRecord): OfflineCityMetadata {
  const meta = saved.tables.gtfsSyncMeta?.[0] as {generationId?: string} | undefined;
  const ptb = saved.tables.ptbBytes?.[0] as {transfersArtifact?: {hash: string}} | undefined;
  return {cityId: saved.cityId, city: saved.city, state: "complete",
    preparedAt: saved.preparedAt, sizeBytes: saved.sizeBytes,
    generationId: meta?.generationId, transfersHash: ptb?.transfersArtifact?.hash};
}

export async function saveDeviceCity(city: CityConfig): Promise<void> {
  const active = useCityDataStore.getState().active;
  if (active?.token.cityId === canonicalCityId(city.id) && active.artifact) {
    await pinCityArtifact(city, active.artifact.key, active.artifact);
    return;
  }
  const artifact = await readCityArtifact(city.id);
  if (artifact) {
    await pinCityArtifact(city, artifact.key);
    return;
  }
  await db.transaction("rw", [...SNAPSHOT_TABLES.map(name => db.table(name)), db.offlineCities, db.offlineCityMetadata, db.offlineTransfers], async () => {
    const tables: Record<string, object[]> = {};
    for (const name of SNAPSHOT_TABLES) {
      tables[name] = name === "ptbBytes" || name === "gtfsBundle"
        ? [await db.table(name).get(city.id)].filter(Boolean) : await db.table(name).toArray();
    }
    const metadata = (tables.gtfsSyncMeta as {cityId: string}[])[0];
    const ptb = tables.ptbBytes[0] as import("../db/index.ts").PtbBytesRecord | undefined;
    const bundle = tables.gtfsBundle[0] as import("../db/index.ts").GtfsBundleRecord | undefined;
    if (metadata?.cityId !== city.id || !ptb?.bytes.byteLength || !bundle?.compressedBytes.byteLength) throw new Error("Load this city's timetable before downloading it");
    if (ptb.transfersArtifact && !await db.offlineTransfers.get(ptb.transfersArtifact.hash)) {
      throw new Error("Walking transfers are not downloaded yet. Try again after route planning is ready.");
    }
    const sizeBytes = ptb.bytes.byteLength + bundle.compressedSize
      + new TextEncoder().encode(JSON.stringify({...tables, ptbBytes: [], gtfsBundle: []})).byteLength;
    const saved = {cityId: city.id, city, preparedAt: Date.now(), sizeBytes, tables};
    await db.offlineCities.put(saved);
    await db.offlineCityMetadata.put(packageMetadata(saved));
  });
}

/** Restore only the selected package. Other installed city packages survive a switch. */
export async function restoreDeviceCity(cityId: string, signal?: AbortSignal): Promise<boolean> {
  return cityDataWrite([...SNAPSHOT_TABLES.map(name => db.table(name)), db.offlineCities, db.offlineCityMetadata, db.offlineTransfers], signal, async () => {
    const saved = await db.offlineCities.get(cityId);
    if (!saved) return false;
    signal?.throwIfAborted();
    for (const name of SNAPSHOT_TABLES) {
      signal?.throwIfAborted();
      if (name !== "ptbBytes") await db.table(name).clear();
      await db.table(name).bulkPut(saved.tables[name] ?? []);
    }
    // The selected legacy payload was already read. Publish its details only
    // after a successful restore, in the same transaction; keep original dates.
    await db.offlineCityMetadata.put(packageMetadata(saved));
    return true;
  });
}

export async function listDeviceCities(): Promise<OfflineCityMetadata[]> {
  return measureCityStage(null, "download-metadata", () => db.transaction("r", db.offlineCities, db.offlineCityMetadata, async () => {
    const [metadata, keys] = await Promise.all([
      db.offlineCityMetadata.toArray(), db.offlineCities.toCollection().primaryKeys(),
    ]);
    const byCity = new Map(metadata.map(row => [row.cityId, row]));
    // Older readers can still add/remove legacy packages after the upgrade.
    // Reconcile keys without cloning their payloads or requiring a write.
    const installed = new Set(keys);
    return [
      ...metadata.filter(row => row.artifactKey || installed.has(row.cityId)),
      ...keys.filter(cityId => !byCity.has(cityId)).map(cityId => ({cityId, state: "legacy" as const})),
    ];
  }));
}

export async function removeDeviceCity(cityId: string): Promise<void> {
  await db.transaction("rw", db.offlineCities, db.offlineCityMetadata, async () => {
    await db.offlineCities.delete(cityId);
    await db.offlineCityMetadata.delete(cityId);
  });
  await collectCityArtifacts(null);
}

/** Cached artifacts are discoverable offline independently of explicit pins.
 * Only the selected legacy projection may use the compatibility fallback. */
export async function hasLiveDeviceCity(cityId: string): Promise<boolean> {
  if (await hasCachedCityArtifact(cityId)) return true;
  const meta = await db.gtfsSyncMeta.get("current");
  if (meta?.cityId !== cityId) return false;
  const [ptb, bundle] = await Promise.all([db.ptbBytes.get(cityId), db.gtfsBundle.get(cityId)]);
  if (!ptb?.bytes.byteLength || !bundle?.compressedBytes.byteLength) return false;
  return !ptb.transfersArtifact || !!await db.offlineTransfers.get(ptb.transfersArtifact.hash);
}
