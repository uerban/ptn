import { useCityDataStore } from "./cityData.ts";
import { canonicalCityId } from "../utils/cityId.ts";
/**
 * Compressed-blob storage helper for the GTFS canonical bundle.
 *
 * This module provides the primary single-blob path while the Dexie display
 * tables remain available to UI surfaces and the routing fallback:
 *
 *   encode:  raw wire data → JSON → gzip → ArrayBuffer → IDB
 *   decode:  IDB → ArrayBuffer → gunzip → JSON → raw wire data
 *
 * gzip over JSON is the chosen codec: CompressionStream/DecompressionStream
 * are universally available (Chrome 80+, Firefox 113+, Safari 16.4+), no
 * new dep needed, and the once-per-sync encoding cost is negligible.
 */

import { db } from "../db/index.ts";

/**
 * Shape of the decoded catalog — what `decodePtbCatalogInWorker` hands back
 * from the `/raptor-bundle` PTB bytes. This is a structural duck-type — we
 * don't want a hard dependency on the catalog module just for a type.
 */
export interface RaptorBundleWire {
  version?: number;
  meta: {
    generatedAt: string;
    cityId?: string;
    /**
     * IANA timezone of the feed's agency (mirrors RoutingBundleData.meta
     * .cityTzIana). Populated on BOTH ingestion paths (PTB sidecar meta +
     * network-GTFS agency.txt); carried on the wire type so it survives
     * `data satisfies RaptorBundleWire` and Dexie re-hydration, keeping the
     * drift guard's warm-path read typed. Additive.
     */
    cityTzIana?: string;
    // Consistent with the server's RoutingBundleData manifest. Not currently
    // consumed via this blob (the shapes artifact is fetched separately in
    // gtfsSync), but carrying the shape lets `data satisfies RaptorBundleWire`
    // pass without a cast.
    shapesArtifact?: { url: string; hash: string; sizeBytes: number };
    /**
     * Pre-computed pedestrian transfers artifact (PTFT wire format) when
     * present on the server. The frontend fetches and decodes the bytes at
     * raptor-index build time; absence means RAPTOR runs without a foot
     * graph (haversine fallback in `findStopsInRadius`).
     */
    transfersArtifact?: { url: string; hash: string; sizeBytes: number };
  };
  routes: Array<{
    id: string;
    shortName: string;
    mode: string;
    color?: string;
    textColor?: string;
    stopIds: string[];
    trips: Array<{
      tripId: string;
      serviceId: string;
      headsign: string;
      // GTFS display direction. Optional when the feed omits direction_id.
      directionId?: 0 | 1;
      // PTB global trip ordinal, used to join GTFS frequencies.txt rows after route-local sorting.
      ptbTripIdx?: number;
      departureSecs: number[];
      // Sparse per-stop dwell, aligned to `stopIds`. Absent when every
      // stop is zero-dwell (the norm). See RoutingBundleTrip.dwellSecs
      // in @pt/shared for the wire-format contract; RAPTOR subtracts
      // this from departureSecs when alighting so terminus-dwell stops
      // report the real arrival_time instead of the later departure.
      dwellSecs?: number[];
      // Sparse per-stop GTFS pickup_type / drop_off_type, aligned to `stopIds` (parallel to
      // `dwellSecs`). `pickup_type == 1` = alight-only; `drop_off_type == 1` = board-only. Absent
      // when every value is default 0 (the norm, and the region-absent case). See
      // ptbToBundleWire.ts and @pt/shared loader.ts `0xFA` StopTimeBoarding for the wire-format
      // contract.
      pickupTypes?: number[];
      dropOffTypes?: number[];
      wheelchairAccessible?: number;
      bikesAllowed?: number;
      // Optional when the feed has no shape reference.
      shapeId?: string;
    }>;
    // Per-direction stop sequences for line-preview rendering. Absent on
    // unidirectional routes — `buildLinePatterns` falls
    // back to the canonical `stopIds` in that case. See `@pt/shared`
    // `RouteDirectionPattern` for the typed contract; this duck-type
    // matches the rest of the wire shape (untrusted, post-JSON.parse).
    directionPatterns?: Array<{
      key: string;
      headsign: string;
      stopIds: string[];
    }>;
  }>;
  calendar: Array<{
    serviceId: string;
    days: boolean[];
    startDate: string;
    endDate: string;
    exceptions: Record<string, number>;
  }>;
  stops: Array<{
    id: string;
    name: string;
    lat: number;
    lon: number;
    wheelchairBoarding?: number;
  }>;
  // GTFS transfers.txt rules (idx→string resolved by ptbToBundleWire). Absent
  // on feeds without transfers.txt. `hydrate` keeps only the
  // UNSCOPED rows and applies transfer_type 3 (not possible) / 2
  // (min_transfer_time) in the RAPTOR scan; scoped fields are carried for the
  // forward-compat S2/S3 slices. Duck-typed (untrusted post-JSON.parse).
  // GTFS reference: https://gtfs.org/documentation/schedule/reference/#transferstxt
  transfers?: Array<{
    // Absent only on a PTB v2 linked row (transfer_type 4/5) keyed by trips.
    fromStopId?: string;
    toStopId?: string;
    transferType: number;
    minTransferSecs?: number;
    fromRouteId?: string;
    toRouteId?: string;
    fromTripId?: string;
    toTripId?: string;
  }>;
  // GTFS frequencies.txt rows keyed by PTB global trip ordinal. Absent on
  // feeds without frequencies.txt.
  frequencies?: Array<{
    tripIdx: number;
    startSecs: number;
    endSecs: number;
    headwaySecs: number;
    exactTimes: 0 | 1;
  }>;
}

// Swallow rejections on the writer side: errors from corrupt/malformed input
// surface through the readable side (which the caller awaits) and would
// otherwise raise an "unhandled rejection" out of the stream adapter.
const swallow = (): void => {};

export async function encodeGzipJson(data: unknown): Promise<{
  compressed: ArrayBuffer;
  decompressedSize: number;
}> {
  const json = JSON.stringify(data);
  const encoded = new TextEncoder().encode(json);
  const decompressedSize = encoded.byteLength;
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(encoded).catch(swallow);
  writer.close().catch(swallow);
  const compressed = await new Response(cs.readable).arrayBuffer();
  return { compressed, decompressedSize };
}

export async function decodeGzipJson<T>(buffer: ArrayBuffer): Promise<T> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(buffer)).catch(swallow);
  writer.close().catch(swallow);
  const text = await new Response(ds.readable).text();
  return JSON.parse(text) as T;
}

export async function writeGtfsBundle(
  cityId: string,
  data: RaptorBundleWire,
): Promise<{ compressedSize: number; decompressedSize: number }> {
  const { compressed, decompressedSize } = await encodeGzipJson(data);
  await db.gtfsBundle.put({
    cityId,
    compressedBytes: compressed,
    format: "gzip",
    bundleGeneratedAt: data.meta.generatedAt,
    compressedSize: compressed.byteLength,
    decompressedSize,
    writtenAt: Date.now(),
  });
  return { compressedSize: compressed.byteLength, decompressedSize };
}

/**
 * Single accessor for the transfers-artifact manifest on the bundle wire.
 * Both engine paths (`raptorIndex.loadFootTransfers` for TS,
 * `wasmLifecycle.attachTransfersIfAvailable` for wasm) read this field;
 * funnelling through one helper means a wire-schema rename touches one
 * place. Returns `undefined` when the wire is absent or carries no
 * manifest — both treated as "no transfers configured for this city".
 */
export function getTransfersManifest(
  wire: RaptorBundleWire | null | undefined,
): { url: string; hash: string; sizeBytes: number } | undefined {
  return wire?.meta.transfersArtifact;
}

export async function readGtfsBundle(
  cityId: string,
): Promise<RaptorBundleWire | null> {
  const active = useCityDataStore.getState().active;
  if (active?.token.cityId === canonicalCityId(cityId)) return active.wire;
  const rec = await db.gtfsBundle.get(cityId);
  if (!rec) return null;
  if (rec.format !== "gzip") {
    // Reject unknown codecs rather than misinterpret bytes. The caller then
    // uses the Dexie display fallback.
    return null;
  }
  try {
    return await decodeGzipJson<RaptorBundleWire>(rec.compressedBytes);
  } catch {
    // Corrupt blob — treat as absent so the Dexie read path takes over.
    return null;
  }
}
