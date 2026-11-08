import "fake-indexeddb/auto";
import {beforeEach, afterEach, expect, it, vi} from "vitest";
import {db, type OfflineCityRecord} from "../db/index.ts";
import {CITIES} from "../config/cities.ts";
import {encodeGzipJson} from "./gtfsBundle.ts";
import {readLegacyCityArtifact} from "./legacyCityArtifact.ts";

const city = CITIES[0];
beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(() => vi.restoreAllMocks());
async function legacy(cityId = city.id, truncated = false): Promise<OfflineCityRecord> {
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const etag = `"${truncated ? hash.slice(0, 32) : hash}"`;
  const encoded = await encodeGzipJson({meta: {cityId, cityTzIana: "UTC", generatedAt: "today"},
    stops: [], routes: [], calendar: []});
  return {cityId, city: {...city, id: cityId}, preparedAt: 1, sizeBytes: 1, tables: {
    gtfsSyncMeta: [{id: "current", cityId, etag, generatedAt: "today", lastSynced: 1, generationId: "old-generation"}],
    ptbBytes: [{cityId, bytes, etag, cityTzIana: "UTC"}],
    gtfsBundle: [{cityId, format: "gzip", compressedBytes: encoded.compressed}],
    gtfsTrips: [{tripId: "must-not-be-restored"}],
  }};
}

it("converts only the requested download without restoring tables or deleting its original", async () => {
  const selected = await legacy();
  await db.offlineCities.bulkPut([selected, await legacy("other")]);
  const read = vi.fn((row: OfflineCityRecord) => {
    if (row.cityId !== city.id) throw new Error("foreign package read");
    return row;
  });
  db.offlineCities.hook("reading", read);
  try {
    const result = await readLegacyCityArtifact(city.id, true);
    expect(result?.generation.generationId).toBe("old-generation");
    expect(result?.cityId).toBe(city.id);
    expect(read).toHaveBeenCalledOnce();
  } finally { db.offlineCities.hook("reading").unsubscribe(read); }
  expect(await db.gtfsTrips.count()).toBe(0);
  expect(await db.offlineCities.count()).toBe(2);
  expect(await db.cityArtifacts.count()).toBe(0);
});

it("verifies a historical truncated ETag before normalizing the internal content identity", async () => {
  await db.offlineCities.put(await legacy(city.id, true));
  const result = await readLegacyCityArtifact(city.id, true);
  expect(result?.ptb.etag).toHaveLength(66);
  expect(result?.ptb.etag).toBe(`"${result?.generation.bundleSha256}"`);
});

it("rejects mixed-city metadata and retains the package for recovery", async () => {
  const saved = await legacy();
  (saved.tables.gtfsSyncMeta[0] as {cityId: string}).cityId = "other";
  await db.offlineCities.put(saved);
  expect(await readLegacyCityArtifact(city.id, true)).toBeUndefined();
  expect(await db.offlineCities.get(city.id)).toBeDefined();
});

it("rejects raw bytes that do not match the legacy content ETag", async () => {
  const saved = await legacy();
  (saved.tables.ptbBytes[0] as {bytes: Uint8Array}).bytes = new Uint8Array([9]);
  await db.offlineCities.put(saved);
  expect(await readLegacyCityArtifact(city.id, true)).toBeUndefined();
});
