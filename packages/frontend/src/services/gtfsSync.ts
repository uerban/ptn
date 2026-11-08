import { aggregateDisplayRoutes } from "./catalogProjection.ts";
import { cityDataWrite } from "./cityDataWrite.ts";
import { measureCityStage } from "./cityPerformance.ts";
import {
  type RoutingBundleData,
} from "@pt/shared";
import { RAPTOR_DATA_VERSION } from "@pt/shared/constants";
import { db } from "../db/index.ts";
import { api } from "./api.ts";
import { shouldWriteShapes, resetQuotaGuardForSync } from "./gtfsQuotaGuard.ts";
import { groupStops, type StopForGrouping } from "./stopGrouping.ts";
import { writeGtfsBundle, type RaptorBundleWire } from "./gtfsBundle.ts";
import { reportError } from "./errorReporter.ts";
import { fetchVerifiedPtb } from "./verifiedCityCatalog.ts";
import { decodePtbCatalogInWorker } from "./ptbCatalogWorkerClient.ts";

interface CatalogResult {
  data: RoutingBundleData | null;
  etag: string;
  generationId: string;
  transfersHash?: string;
  shapesHash?: string;
  /** False for an offline cached-catalog no-op; never advance lastSynced then. */
  revalidated?: boolean;
}

interface PriorCatalogMeta {
  cityId: string;
  etag: string;
  generationId: string;
  transfersHash?: string;
  shapesHash?: string;
}

async function hasUsableCachedBundle(cityId: string): Promise<boolean> {
  const cached = await db.gtfsBundle.get(cityId);
  return cached !== undefined &&
    cached.compressedSize > 0 &&
    cached.compressedBytes.byteLength > 0;
}

async function fetchCatalog(
  cityId: string,
  meta: PriorCatalogMeta | undefined,
  requireNetwork = false,
): Promise<CatalogResult> {
  try {
    // Bracket the bundle fetch with the Rust generation id. If pt-serve swaps
    // between the requests, fail the sync instead of pairing PTB A with
    // shapes B. The ETag carries the PTB hash, which stays stable across an
    // OSM-sidecar-only publication, so that revalidates with a 304.
    const {ptb, generation: after} = await fetchVerifiedPtb(cityId);

    if (
      meta?.cityId === cityId &&
      meta.etag === ptb.etag &&
      meta.generationId === after.generationId &&
      meta.transfersHash === ptb.transfersArtifact?.hash &&
      meta.shapesHash === after.shapesArtifact?.hash
    ) {
      if (await hasUsableCachedBundle(cityId)) {
        return {
          data: null,
          etag: ptb.etag,
          generationId: after.generationId,
          ...(ptb.transfersArtifact ? { transfersHash: ptb.transfersArtifact.hash } : {}),
          ...(after.shapesArtifact ? { shapesHash: after.shapesArtifact.hash } : {}),
        };
      }
    }

    const data = await measureCityStage(cityId, "catalog-decode", () => decodePtbCatalogInWorker(ptb.bytes, {
      cityId,
      generation: after,
      ...(ptb.transfersArtifact ? { transfersArtifact: ptb.transfersArtifact } : {}),
    }));
    return {
      data,
      etag: ptb.etag,
      generationId: after.generationId,
      ...(ptb.transfersArtifact ? { transfersHash: ptb.transfersArtifact.hash } : {}),
      ...(after.shapesArtifact ? { shapesHash: after.shapesArtifact.hash } : {}),
    };
  } catch (error) {
    if (requireNetwork) throw error;
    // OFFLINE BOOT. A stale-but-valid local catalog must still boot with no
    // network at all. Do not call this a 304: no server confirmed it, so
    // `revalidated: false` keeps lastSynced where it is.
    if (
      meta?.cityId === cityId &&
      await hasUsableCachedBundle(cityId)
    ) {
      return {
        data: null,
        etag: meta.etag,
        generationId: meta.generationId,
        transfersHash: meta.transfersHash,
        shapesHash: meta.shapesHash,
        revalidated: false,
      };
    }
    throw error;
  }
}

export async function syncGtfsData(cityId: string, opts: {requireNetwork?: boolean; signal?: AbortSignal} = {}): Promise<boolean> {
  opts.signal?.throwIfAborted();
  performance.mark("ptn:gtfs-sync-start");
  resetQuotaGuardForSync();

  const meta = await db.gtfsSyncMeta.get("current");
  const result = await measureCityStage(cityId, "catalog-fetch", () => fetchCatalog(cityId, meta, opts.requireNetwork));

  opts.signal?.throwIfAborted();

  if (result.data?.version && result.data.version > RAPTOR_DATA_VERSION) {
    console.warn(`Catalog wire version ${result.data.version} is newer than expected (client supports ${RAPTOR_DATA_VERSION}). Some fields may be unsupported.`);
  }

  if (!result.data) {
    if (result.revalidated === false) return false;

    // Nothing to write: the served generation matches what we already hold.
    // `fetchCatalog` only answers with no data after confirming the cached
    // bundle is usable — that check is what makes this a no-op instead of a
    // re-fetch.
    //
    // Only stamp when meta belongs to the city we just synced — marking a
    // foreign meta row as freshly-synced would suppress its next legitimate
    // sync.
    if (meta && meta.cityId === cityId) {
      await cityDataWrite([db.gtfsSyncMeta], opts.signal, async () => {
        await db.gtfsSyncMeta.put({ ...meta, lastSynced: Date.now() });
      });
    }
    return false;
  }
  const data = result.data;

  // tz drift triage (fresh fetch only; the warm path's indicator state is set in gtfsDataStore from
  // RaptorIndex.cityTzIana — [v4 BLOCKING #1]). Absent metaTz (the network-GTFS path) is NOT drift
  // — it simply can't cross-check, so no warning fires there.
  {
    const { CITIES } = await import("../config/cities.ts");
    const configTz = CITIES.find((c) => c.id === cityId)?.tz;
    const metaTz = data.meta.cityTzIana;
    if (configTz && metaTz && configTz !== metaTz) {
      console.warn(`[gtfsSync] tz drift for ${cityId}: config=${configTz} bundle=${metaTz}`);
    }
  }

  const trips = data.routes.flatMap((r) => r.trips.map((t) => ({
    tripId: t.tripId, routeId: r.id, serviceId: t.serviceId,
    headsign: t.headsign, departureSecs: t.departureSecs,
    directionId: t.directionId,
    ptbTripIdx: t.ptbTripIdx,
    dwellSecs: t.dwellSecs,
    wheelchairAccessible: t.wheelchairAccessible,
    bikesAllowed: t.bikesAllowed,
    shapeId: t.shapeId,
  })));

  let shapes: Array<{ shapeId: string; encodedPolyline: string; source: "gtfs" }> = [];
  const shapesArtifact = data.meta.shapesArtifact;
  if (shapesArtifact) {
    const writeOk = await shouldWriteShapes();
    if (!writeOk) {
      console.warn("[gtfsSync] IDB quota > 70%; skipping shapes artifact");
      for (const t of trips) t.shapeId = undefined;
    } else {
      try {
        const fetched = await measureCityStage(cityId, "shapes-fetch", () => api.fetchShapesArtifact(shapesArtifact.url, shapesArtifact.hash));
        if (fetched.hash !== shapesArtifact.hash) {
          throw new Error(
            `shapes artifact hash mismatch: got ${fetched.hash}, expected ${shapesArtifact.hash}`,
          );
        }
        shapes = fetched.shapes;
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)), {
          context: { where: "gtfsSync.fetchShapesArtifact", cityId },
        });
        for (const t of trips) t.shapeId = undefined;
      }
    }
  }

  // Wrap all writes in a Dexie transaction to prevent inconsistent state
  // if the browser closes mid-sync. Also clear all tables before writing
  // to remove stale records (e.g., routes/trips absent from new data).
  await measureCityStage(cityId, "projection-write", () => cityDataWrite([
    db.gtfsRoutes, db.gtfsTrips, db.gtfsServices, db.gtfsStops,
    db.gtfsShapes, db.gtfsSyncMeta,
  ], opts.signal, async () => {
    await Promise.all([
      db.gtfsRoutes.clear(),
      db.gtfsTrips.clear(),
      db.gtfsServices.clear(),
      db.gtfsStops.clear(),
      db.gtfsShapes.clear(),
    ]);
    // Write DISPLAY-aggregated routes (one row per route_id). Under Unbounded
    // mode the wire carries per-pattern records with repeated route_ids; bulkPut
    // into db.gtfsRoutes (PK=id) would collapse to the last pattern. The
    // per-pattern records live only in the gtfsBundle blob written below.
    const displayRoutes = aggregateDisplayRoutes(data.routes);
    await db.gtfsRoutes.bulkPut(displayRoutes.map((r) => ({
      id: r.id, shortName: r.shortName, mode: r.mode,
      color: r.color, textColor: r.textColor, stopIds: r.stopIds,
      ...(r.directionPatterns && r.directionPatterns.length > 0
        ? { directionPatterns: r.directionPatterns }
        : {}),
    })));
    await measureCityStage(cityId, "trip-write", () => db.gtfsTrips.bulkPut(trips));
    await db.gtfsServices.bulkPut(data.calendar.map((s) => ({
      serviceId: s.serviceId, days: s.days,
      startDate: s.startDate, endDate: s.endDate, exceptions: s.exceptions,
    })));
    await db.gtfsStops.bulkPut(data.stops.map((s) => ({
      id: s.id, name: s.name, lat: s.lat, lon: s.lon,
      wheelchairBoarding: s.wheelchairBoarding,
    })));
    await db.gtfsShapes.bulkPut(shapes);
    await db.gtfsSyncMeta.put({
      id: "current", cityId, etag: result.etag,
      lastSynced: Date.now(), generatedAt: data.meta.generatedAt,
      generationId: result.generationId,
      ...(result.transfersHash ? { transfersHash: result.transfersHash } : {}),
      ...(result.shapesHash ? { shapesHash: result.shapesHash } : {}),
      ...(data.frequencies && data.frequencies.length > 0 ? { frequencies: data.frequencies } : {}),
    });
  }));

  // Persist the compressed bundle alongside the Dexie display fallback.
  // The read path prefers the blob when present; the tables remain populated
  // for UI surfaces and a recoverable fallback. Non-fatal for the user, but
  // ops needs visibility (reportError) and a failed overwrite must not leave
  // a stale blob around to serve data from the previous city.
  opts.signal?.throwIfAborted();
  try {
    await measureCityStage(cityId, "catalog-persist", () => writeGtfsBundle(cityId, data satisfies RaptorBundleWire));
  } catch (err) {
    opts.signal?.throwIfAborted();
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { where: "gtfsSync.writeGtfsBundle", cityId },
    });
    try {
      await db.gtfsBundle.delete(cityId);
    } catch (deleteErr) {
      console.warn("Failed to clear stale bundle after write failure", deleteErr);
    }
  }

  // Compute stop groups after the main transaction completes.
  // parentStation is not exported by the backend, so it is omitted here;
  // groupStops falls back to name+proximity clustering.
  try {
    const stopsForGrouping: StopForGrouping[] = data.stops.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      parentStation: undefined,
    }));
    const groups = groupStops(stopsForGrouping);

    // Wrap in transaction to prevent useLiveQuery flicker during the clear+write.
    await measureCityStage(cityId, "stop-groups-write", () => cityDataWrite([db.stopGroups], opts.signal, async () => {
      await db.stopGroups.clear();
      await db.stopGroups.bulkPut(groups);
    }));
  } catch (err) {
    opts.signal?.throwIfAborted();
    console.warn("Stop grouping failed (non-fatal):", err);
  }

  performance.mark("ptn:gtfs-sync-end");
  performance.measure("ptn:gtfs-sync", "ptn:gtfs-sync-start", "ptn:gtfs-sync-end");

  return true;
}

export async function clearGtfsData(): Promise<void> {
  await cityDataWrite([
    db.gtfsRoutes, db.gtfsTrips, db.gtfsServices, db.gtfsStops,
    db.gtfsBundle, db.gtfsShapes, db.gtfsSyncMeta, db.stopGroups,
  ], undefined, async () => { await Promise.all([
    db.gtfsRoutes.clear(),
    db.gtfsTrips.clear(),
    db.gtfsServices.clear(),
    db.gtfsStops.clear(),
    db.gtfsBundle.clear(),
    db.gtfsShapes.clear(),
    db.gtfsSyncMeta.clear(),
    db.stopGroups.clear(),
  ]); });
}

export async function needsSync(cityId: string, maxAgeMs: number): Promise<boolean> {
  const meta = await db.gtfsSyncMeta.get("current");
  if (!meta) return true;
  if (meta.cityId !== cityId) return true;
  return Date.now() - meta.lastSynced > maxAgeMs;
}
