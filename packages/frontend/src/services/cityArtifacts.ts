import {db, type CityArtifactRecord, type CityArtifactMetadata} from "../db/index.ts";
import type {CityConfig} from "../config/cities.ts";
import type {FetchPtbBytesResult} from "./gtfsBundleBytes.ts";
import type {PtbCatalogGeneration} from "./ptbCatalog.ts";
import {canonicalCityId} from "../utils/cityId.ts";
import {cityDataWrite} from "./cityDataWrite.ts";
import {ensureTransferArtifactStored} from "./transfersArtifact.ts";
import {ensureSharedArtifactStored, holdSharedArtifactReferences, sharedArtifactReferences, sharedArtifactEpoch} from "./sharedCityArtifacts.ts";
import {fetchCityShapes} from "./cityShapes.ts";

import {recalledCityArtifact, rememberCityArtifact} from "./cityArtifactMemory.ts";

import {measureCityStage} from "./cityPerformance.ts";

export const CITY_ARTIFACT_CACHE_BUDGET = 64 * 1024 * 1024;

function keyFor(cityId: string, generation: PtbCatalogGeneration, ptb: FetchPtbBytesResult): string {
  return JSON.stringify([1, cityId, generation.generationId, generation.bundleSha256,
    ptb.transfersArtifact?.hash ?? null, generation.shapesArtifact?.hash ?? null]);
}

async function verifyContent(generation: PtbCatalogGeneration, ptb: FetchPtbBytesResult): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(ptb.bytes));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== generation.bundleSha256 || ptb.etag !== `"${hash}"`) throw new Error("City artifact content hash mismatch");
}

function metadataFor(artifact: CityArtifactRecord): CityArtifactMetadata {
  return {key: artifact.key, cityId: artifact.cityId, generationId: artifact.generation.generationId,
    sizeBytes: artifact.ptb.bytes.byteLength + (artifact.ptb.transfersArtifact?.sizeBytes ?? 0) + (artifact.generation.shapesArtifact?.sizeBytes ?? 0),
    ptbSizeBytes: artifact.ptb.bytes.byteLength, transfersSizeBytes: artifact.ptb.transfersArtifact?.sizeBytes,
    createdAt: Date.now(), transfersHash: artifact.ptb.transfersArtifact?.hash, shapesArtifact: artifact.generation.shapesArtifact};
}

/** Construct only after /ready bracketing and successful catalog decoding.
 * Hash validation also prevents an inconsistent ETag from poisoning offline use. */
export async function prepareCityArtifact(cityId: string, generation: PtbCatalogGeneration,
  ptb: FetchPtbBytesResult): Promise<CityArtifactRecord> {
  cityId = canonicalCityId(cityId);
  if (!ptb.bytes.byteLength || ptb.etag !== `"${generation.bundleSha256}"` ||
      (ptb.cityTzIana !== undefined && ptb.cityTzIana !== generation.cityTzIana)) {
    throw new Error("City artifact provenance mismatch");
  }
  const bytes = new Uint8Array(ptb.bytes);
  await verifyContent(generation, {...ptb, bytes});
  const key = keyFor(cityId, generation, ptb);
  return {key, cityId, generation: structuredClone(generation), ptb: {...structuredClone(ptb), bytes}};
}

export async function cityArtifactPointer(cityId: string): Promise<string | null> {
  return measureCityStage(cityId, "catalog-expected-pointer", async () =>
    (await db.cityCachePointers.get(canonicalCityId(cityId)))?.artifactKey ?? null);
}

/** Availability discovery does not clone the timetable. Activation verifies
 * the selected payload before it becomes usable. Publication is atomic. */
export async function hasCachedCityArtifact(cityId: string): Promise<boolean> {
  cityId = canonicalCityId(cityId);
  return db.transaction("r", db.cityCachePointers, db.cityArtifactMetadata, async () => {
    const pointer = await db.cityCachePointers.get(cityId);
    if (!pointer) return false;
    const metadata = await db.cityArtifactMetadata.get(pointer.artifactKey);
    return metadata?.cityId === cityId;
  });
}

/** Atomically publish a complete artifact. CAS rejects a slow older refresh.
 * A failed quota write/abort leaves the previous pointer and payload intact. */
export async function publishCityArtifact(artifact: CityArtifactRecord, expectedKey: string | null,
  signal?: AbortSignal, repairPayload = false): Promise<boolean> {
  return cityDataWrite([db.cityArtifacts, db.cityArtifactMetadata, db.cityCachePointers], signal, async () => {
    const current = await db.cityCachePointers.get(artifact.cityId);
    if ((current?.artifactKey ?? null) !== expectedKey) return false;
    const existing = await db.cityArtifactMetadata.get(artifact.key);
    if (repairPayload || !existing) {
      // Verified identical content identity may repair a corrupt/missing disk
      // payload; it does not replace this key with a different generation.
      await db.cityArtifacts.put(artifact);
      await db.cityArtifactMetadata.put(metadataFor(artifact));
    } else {
      // Upgrade compact accounting lazily, without rewriting the raw payload.
      await db.cityArtifactMetadata.put({...metadataFor(artifact), createdAt: existing.createdAt});
    }
    await db.cityCachePointers.put({cityId: artifact.cityId, artifactKey: artifact.key, lastUsedAt: Date.now()});
    return true;
  });
}

/** Capture the ordinary pointer, preferred pin and selected payload together.
 * Activation uses this same pointer for publication CAS instead of reading it
 * again after an optional stop-cache write has entered the storage queue. */
export async function readCityArtifactSnapshot(cityId: string, preferDownload = false): Promise<{
  pointerKey: string | null; artifact: CityArtifactRecord | undefined;
}> {
  const readEpoch = sharedArtifactEpoch();
  cityId = canonicalCityId(cityId);
  const snapshot = await measureCityStage(cityId, "catalog-snapshot-read", () => db.transaction("r",
    db.cityArtifacts, db.cityCachePointers, db.offlineCityMetadata, async () => {
      const pointerKey = (await db.cityCachePointers.get(cityId))?.artifactKey ?? null;
      const download = preferDownload ? await db.offlineCityMetadata.get(cityId) : undefined;
      const key = download?.artifactKey ?? pointerKey;
      if (!key) return {pointerKey, artifact: undefined, verified: false};
      const resident = recalledCityArtifact(key);
      if (resident?.cityId === cityId) return {pointerKey, artifact: resident, verified: true};
      const artifact = await db.cityArtifacts.get(key);
      if (!artifact) throw new Error("City artifact payload is missing");
      if (artifact.key !== key || artifact.cityId !== cityId || artifact.key !== keyFor(cityId, artifact.generation, artifact.ptb)) {
        throw new Error("City artifact identity mismatch");
      }
      return {pointerKey, artifact, verified: false};
    }));
  // WebCrypto must remain outside the IndexedDB transaction.
  if (snapshot.artifact && !snapshot.verified) {
    const artifact = snapshot.artifact;
    await measureCityStage(cityId, "catalog-hash", () => verifyContent(artifact.generation, artifact.ptb));
    if (readEpoch === sharedArtifactEpoch()) rememberCityArtifact(artifact);
  }
  return {pointerKey: snapshot.pointerKey, artifact: snapshot.artifact};
}

/** Read only the requested city, with an explicit download taking precedence. */
export async function readCityArtifact(cityId: string, preferDownload = false): Promise<CityArtifactRecord | undefined> {
  return (await readCityArtifactSnapshot(cityId, preferDownload)).artifact;
}

/** Pin a complete immutable generation, without snapshotting any projection. */
export async function pinCityArtifact(city: CityConfig, artifactKey: string, activeArtifact?: CityArtifactRecord): Promise<void> {
  const epoch = sharedArtifactEpoch();
  const assertCurrent = () => {
    if (sharedArtifactEpoch() !== epoch) throw new DOMException("Download cache was cleared during pinning", "AbortError");
  };
  const source = activeArtifact ?? await db.cityArtifacts.get(artifactKey);
  assertCurrent();
  if (source?.key !== artifactKey || source.cityId !== canonicalCityId(city.id) ||
      source.key !== keyFor(source.cityId, source.generation, source.ptb)) throw new Error("City artifact is not stored");
  const details = metadataFor(source);
  const release = holdSharedArtifactReferences({artifactKey, transfersHash: details.transfersHash,
    shapesHash: details.shapesArtifact?.hash});
  try {
    await verifyContent(source.generation, source.ptb);
    assertCurrent();
    if (details?.transfersHash) await ensureTransferArtifactStored(details.transfersHash);
    if (details?.shapesArtifact) {
      await fetchCityShapes(details.shapesArtifact.url, details.shapesArtifact.hash);
      assertCurrent();
      await ensureSharedArtifactStored("shapes", details.shapesArtifact.hash);
    }
    assertCurrent();
    await db.transaction("rw", [db.cityArtifacts, db.cityArtifactMetadata, db.offlineCityMetadata, db.offlineCities,
      db.offlineTransfers, db.cityShapes], async () => {
        assertCurrent();
        let artifact = await db.cityArtifactMetadata.get(artifactKey);
        if (!artifact) {
          // Download the exact displayed generation even while its background
          // cache publication is pending. Never move a newer cache pointer back.
          artifact = details;
          await db.cityArtifactMetadata.add(artifact);
        } else {
          artifact = {...details, createdAt: artifact.createdAt};
          await db.cityArtifactMetadata.put(artifact);
        }
        // A valid resident memo does not prove the disk payload is still intact.
        // Explicit download completion durably writes the verified displayed
        // bytes, repairing a missing/corrupt row in the same pin transaction.
        await db.cityArtifacts.put(source);
        if (artifact?.cityId !== canonicalCityId(city.id)) throw new Error("City artifact is not stored");
        if (artifact.transfersHash && !await db.offlineTransfers.get(artifact.transfersHash)) {
          throw new Error("Walking transfers are not downloaded yet");
        }
        if (artifact.shapesArtifact && !await db.cityShapes.get(artifact.shapesArtifact.hash)) throw new Error("City shapes are not downloaded yet");
        assertCurrent();
        await db.offlineCityMetadata.put({cityId: artifact.cityId, city, state: "complete", artifactKey,
          generationId: artifact.generationId,
          preparedAt: Date.now(), sizeBytes: artifact.sizeBytes, transfersHash: artifact.transfersHash, shapesHash: artifact.shapesArtifact?.hash});
        // Publish the replacement before discarding its legacy snapshot, together.
        await db.offlineCities.delete(artifact.cityId);
        assertCurrent();
      });
    assertCurrent();
  } catch (error) {
    assertCurrent();
    throw error;
  } finally { release(); }
}

/** Bounded ordinary cache; downloads and the installed context are exempt.
 * Inventory/pointers are tiny: never scan or clone inactive PTB payloads. */
export async function collectCityArtifacts(activeKey: string | null,
  budgetBytes = CITY_ARTIFACT_CACHE_BUDGET): Promise<void> {
  await db.transaction("rw", [db.cityArtifacts, db.cityArtifactMetadata, db.cityCachePointers,
    db.offlineCityMetadata, db.offlineCities, db.ptbBytes, db.offlineTransfers, db.cityShapes, db.sharedArtifactMetadata], async () => {
    const [metadata, pointers, downloads, sidecars, legacyPackages, legacyRaw, transferKeys, shapeKeys] = await Promise.all([
      db.cityArtifactMetadata.toArray(), db.cityCachePointers.toArray(), db.offlineCityMetadata.toArray(),
      db.sharedArtifactMetadata.toArray(), db.offlineCities.toCollection().primaryKeys(), db.ptbBytes.toCollection().primaryKeys(),
      db.offlineTransfers.toCollection().primaryKeys(), db.cityShapes.toCollection().primaryKeys(),
    ]);
    const protectedKeys = new Set(downloads.flatMap(row => row.artifactKey ? [row.artifactKey] : []));
    if (activeKey) protectedKeys.add(activeKey);
    const protectedSidecars = new Set<string>();
    for (const row of downloads) {
      if (row.transfersHash) protectedSidecars.add('transfers:' + row.transfersHash);
      if (row.shapesHash) protectedSidecars.add('shapes:' + row.shapesHash);
    }
    const addLeases = () => {
      for (const row of sharedArtifactReferences()) {
        if (row.artifactKey) protectedKeys.add(row.artifactKey);
        if (row.transfersHash) protectedSidecars.add('transfers:' + row.transfersHash);
        if (row.shapesHash) protectedSidecars.add('shapes:' + row.shapesHash);
      }
    };
    addLeases();
    const byKey = new Map(metadata.map(row => [row.key, row]));
    const inventory = new Map(sidecars.map(row => [row.key, row]));
    const auxiliary = (row: CityArtifactMetadata): [string, number][] => [
      ...(row.transfersHash ? [['transfers:' + row.transfersHash, row.transfersSizeBytes ?? 0] as [string, number]] : []),
      ...(row.shapesArtifact ? [['shapes:' + row.shapesArtifact.hash, row.shapesArtifact.sizeBytes] as [string, number]] : []),
    ];
    for (const row of metadata) if (protectedKeys.has(row.key)) for (const [key] of auxiliary(row)) protectedSidecars.add(key);
    const counted = new Set(protectedSidecars);
    const retained = new Set(protectedKeys);
    let bytes = 0;
    const budget = Math.max(0, budgetBytes);
    for (const pointer of pointers.sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
      const row = byKey.get(pointer.artifactKey);
      if (!row) { await db.cityCachePointers.delete(pointer.cityId); continue; }
      if (protectedKeys.has(row.key)) continue;
      const rawSize = row.ptbSizeBytes ?? Math.max(0, row.sizeBytes - (row.transfersSizeBytes ?? 0) - (row.shapesArtifact?.sizeBytes ?? 0));
      const additional = auxiliary(row).filter(([key]) => !counted.has(key));
      const cost = rawSize + additional.reduce((sum, [key, declared]) => sum + (inventory.get(key)?.sizeBytes ?? declared), 0);
      if (bytes + cost <= budget) {
        bytes += cost; retained.add(row.key);
        for (const [key] of additional) counted.add(key);
      } else await db.cityCachePointers.delete(pointer.cityId);
    }
    // Re-read in-memory leases after awaited operations; pin publication itself
    // is serialized against this transaction's metadata locks.
    addLeases();
    for (const key of protectedKeys) retained.add(key);
    const used = new Set(protectedSidecars);
    for (const row of metadata) if (retained.has(row.key)) for (const [key] of auxiliary(row)) used.add(key);
    const dead = metadata.filter(row => !retained.has(row.key)).map(row => row.key);
    await db.cityArtifacts.bulkDelete(dead);
    await db.cityArtifactMetadata.bulkDelete(dead);
    // Unknown legacy downloads/raw caches may reference transfer hashes that
    // have not been discovered yet. Preserve them without cloning snapshots.
    const unknownLegacy = legacyRaw.length > 0 || legacyPackages.some(id =>
      !downloads.some(row => row.cityId === id && row.state === 'complete' && (row.artifactKey || row.transfersHash)));
    const payloadKeys = new Set([...transferKeys.map(hash => 'transfers:' + hash), ...shapeKeys.map(hash => 'shapes:' + hash)]);
    for (const row of sidecars.sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
      if (used.has(row.key)) continue;
      if (!payloadKeys.has(row.key)) continue;
      if (row.kind === 'transfers' && unknownLegacy) { used.add(row.key); continue; }
      if (row.sizeBytes !== undefined && bytes + row.sizeBytes <= budget) {
        bytes += row.sizeBytes; used.add(row.key);
      }
    }
    addLeases();
    for (const key of protectedSidecars) used.add(key);
    await db.offlineTransfers.bulkDelete(unknownLegacy ? [] : transferKeys.filter(hash => !used.has('transfers:' + hash)));
    await db.cityShapes.bulkDelete(shapeKeys.filter(hash => !used.has('shapes:' + hash)));
    await db.sharedArtifactMetadata.bulkDelete(sidecars.filter(row => !used.has(row.key)).map(row => row.key));
  });
}
