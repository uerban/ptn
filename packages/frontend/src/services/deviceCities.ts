import {db, type OfflineCityRecord} from "../db/index.ts";
import type {CityConfig} from "../config/cities.ts";

const SNAPSHOT_TABLES = ["gtfsRoutes", "gtfsTrips", "gtfsServices", "gtfsStops", "gtfsShapes", "gtfsSyncMeta", "stopGroups", "gtfsBundle", "ptbBytes"] as const;

export async function saveDeviceCity(city: CityConfig): Promise<void> {
  await db.transaction("rw", [...SNAPSHOT_TABLES.map(name => db.table(name)), db.offlineCities, db.offlineTransfers], async () => {
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
    await db.offlineCities.put({cityId: city.id, city, preparedAt: Date.now(), sizeBytes, tables});
  });
}

/** Restore only the selected package. Other installed city packages survive a switch. */
export async function restoreDeviceCity(cityId: string, signal?: AbortSignal): Promise<boolean> {
  return db.transaction("rw", [...SNAPSHOT_TABLES.map(name => db.table(name)), db.offlineCities, db.offlineTransfers], async () => {
    const saved = await db.offlineCities.get(cityId);
    if (!saved) return false;
    signal?.throwIfAborted();
    for (const name of SNAPSHOT_TABLES) {
      signal?.throwIfAborted();
      if (name !== "ptbBytes") await db.table(name).clear();
      await db.table(name).bulkPut(saved.tables[name] ?? []);
    }
    return true;
  });
}

export async function listDeviceCities(): Promise<OfflineCityRecord[]> {
  return db.offlineCities.toArray();
}

export async function removeDeviceCity(cityId: string): Promise<void> {
  await db.transaction("rw", db.offlineCities, db.offlineTransfers, db.ptbBytes, async () => {
    await db.offlineCities.delete(cityId);
    // Include the live cache as well as retained packages when collecting references.
    const packages = await db.offlineCities.toArray();
    const rows = [...await db.ptbBytes.toArray(), ...packages.flatMap(p => p.tables.ptbBytes as {transfersArtifact?: {hash: string}}[])];
    const used = new Set(rows.flatMap(row => row.transfersArtifact ? [row.transfersArtifact.hash] : []));
    const unused = (await db.offlineTransfers.toCollection().primaryKeys()).filter(hash => !used.has(hash));
    await db.offlineTransfers.bulkDelete(unused);
  });
}

/** The current live cache may already be usable offline, even without a
 * retained download. Unlike a package, that cache is discarded on city switch. */
export async function hasLiveDeviceCity(cityId: string): Promise<boolean> {
  const meta = await db.gtfsSyncMeta.get("current");
  const [ptb, bundle] = await Promise.all([db.ptbBytes.get(cityId), db.gtfsBundle.get(cityId)]);
  if (meta?.cityId !== cityId || !ptb?.bytes.byteLength || !bundle?.compressedBytes.byteLength) return false;
  return !ptb.transfersArtifact || !!await db.offlineTransfers.get(ptb.transfersArtifact.hash);
}
