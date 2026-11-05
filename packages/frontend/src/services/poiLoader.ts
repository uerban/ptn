import Dexie from "dexie";
import { discoverPoiBundleResource } from "./poiManifest.ts";
import { db } from "../db/index.ts";
import type { PoiIndexRecord } from "../db/index.ts";
import type { PoiBundle, PoiEntry } from "@pt/shared";
import { registerEvictor, notifyWriteGrew, onQuotaNear } from "./storagePolicy.ts";
import { reportError } from "./errorReporter.ts";
import { decompressBrotli } from "./brotliDecode.ts";
// Self-namespace import so `loadPoiBundle` reaches `fetchPoiBundle` THROUGH the
// module's exported binding rather than the closure-local one. Under Vite/ESM a
// bare local call (`fetchPoiBundle(...)`) is invisible to `vi.spyOn(poiLoader,
// "fetchPoiBundle")` (the spy patches the namespace object, not the closure
// binding), which silently neuters the residency guard's 0-call assertion. Going
// via `self.fetchPoiBundle` routes the call through the live mutable export so
// the spy is honoured. No production behaviour change — same function, same args.
import * as self from "./poiLoader.ts";

export type PoiLoadErrorKind = "missing" | "fetch" | "parse" | "quota";

export interface PoiLoadError {
  kind: PoiLoadErrorKind;
  cityId: string;
  tier: "strict" | "loose";
  message: string;
  timestamp: number;
  hasCachedFallback?: boolean;
}

export type PoiLoadStatusListener = (errors: ReadonlyMap<string, PoiLoadError>) => void;

/** Rows per IndexedDB write while installing a POI bundle tier. */
export const POI_WRITE_CHUNK = 250;

const bundleRevisions = new WeakMap<PoiBundle, number>();

const loadErrors = new Map<string, PoiLoadError>();
const listeners = new Set<PoiLoadStatusListener>();
const loadGenerations = new Map<string, number>();
const activeLoadControllers = new Map<
  string,
  { gen: number; controller: AbortController }
>();

class StalePoiLoadError extends Error {}

function isCurrentLoad(cityId: string, gen?: number): boolean {
  return gen === undefined || loadGenerations.get(cityId) === gen;
}

function assertCurrentLoad(cityId: string, gen?: number): void {
  if (!isCurrentLoad(cityId, gen)) throw new StalePoiLoadError();
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorKey(cityId: string, tier: "strict" | "loose"): string {
  return `${cityId}:${tier}`;
}

function setLoadError(cityId: string, tier: "strict" | "loose", kind: PoiLoadErrorKind, message: string, gen?: number): void {
  if (gen !== undefined && loadGenerations.get(cityId) !== gen) return;
  loadErrors.set(errorKey(cityId, tier), { kind, cityId, tier, message, timestamp: Date.now() });
  for (const fn of listeners) fn(loadErrors);
}

function clearLoadError(cityId: string, tier: "strict" | "loose", gen?: number): void {
  if (gen !== undefined && loadGenerations.get(cityId) !== gen) return;
  if (loadErrors.delete(errorKey(cityId, tier))) {
    for (const fn of listeners) fn(loadErrors);
  }
}

export function getPoiLoadErrors(): ReadonlyMap<string, PoiLoadError> {
  return loadErrors;
}

export function onPoiLoadStatusChange(listener: PoiLoadStatusListener): () => void {
  listeners.add(listener);
  if (loadErrors.size > 0) {
    listener(loadErrors);
  }
  return () => { listeners.delete(listener); };
}

export function __resetPoiLoadStatusForTests(): void {
  for (const { controller } of activeLoadControllers.values()) controller.abort();
  activeLoadControllers.clear();
  loadErrors.clear();
  listeners.clear();
  loadGenerations.clear();
}

/** Invalidates and aborts every whole-bundle load owned by an older POI sync. */
export function cancelPoiBundleLoads(): void {
  for (const [cityId, { controller }] of activeLoadControllers) {
    loadGenerations.set(cityId, (loadGenerations.get(cityId) ?? 0) + 1);
    controller.abort();
  }
  activeLoadControllers.clear();
}

function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "QuotaExceededError") return true;
  if (err instanceof Error && err.name === "QuotaExceededError") return true;
  return false;
}

export function computeGeoBucket(lat: number, lon: number): string {
  return `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`;
}

export function entryToRecord(entry: PoiEntry, cityId: string): PoiIndexRecord {
  return {
    ...entry,
    id: `${cityId}:${entry.id}`,
    cityId,
    geoBucket: computeGeoBucket(entry.lat, entry.lon),
  };
}

export async function fetchPoiBundle(
  cityId: string,
  tier: "strict" | "loose" = "strict",
  gen?: number,
  signal?: AbortSignal,
): Promise<PoiBundle | null> {
  const resource = await discoverPoiBundleResource(cityId, tier);
  if (signal?.aborted || !isCurrentLoad(cityId, gen)) return null;
  if (resource === "not-deployed") {
    // Same as a missing bundle on a deployment without POI: stops-only search,
    // no error banner. Offline rows stay usable.
    console.warn(`[PTN] No POI manifest deployed — stops-only search for ${cityId}`);
    clearLoadError(cityId, tier, gen);
    return null;
  }
  if (!resource) {
    if (tier === "strict") setLoadError(cityId, tier, "missing", `POI bundle not available for ${cityId}`, gen);
    return null;
  }
  const url = resource.url;
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "force-cache",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted || !isCurrentLoad(cityId, gen) || isAbortError(err)) {
      return null;
    }
    const msg = `POI bundle fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { source: "poiLoader.fetch", cityId },
    });
    setLoadError(cityId, tier, "fetch", msg, gen);
    return null;
  }

  if (signal?.aborted || !isCurrentLoad(cityId, gen)) return null;

  if (!response.ok) {
    if (response.status === 404) {
      if (tier === "loose") {
        console.warn(`[PTN] Loose POI bundle not found for ${cityId} — strict-only search for this city`);
        clearLoadError(cityId, tier, gen);
        return null;
      }
      console.warn(`[PTN] POI bundle not found for ${cityId} (${tier}), falling back to stops-only search`);
      setLoadError(cityId, tier, "missing", `POI bundle not available for ${cityId}`, gen);
    } else {
      const msg = `POI bundle fetch failed: ${response.status}`;
      reportError(new Error(msg), {
        context: { source: "poiLoader.fetch", cityId, status: response.status },
      });
      setLoadError(cityId, tier, "fetch", msg, gen);
    }
    return null;
  }

  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("POI response has no body");
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > resource.sizeBytes) throw new Error("POI response exceeds advertised size");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    if (received !== resource.sizeBytes) throw new Error("POI response size mismatch");
    const buffer = new ArrayBuffer(received);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== resource.sha256) throw new Error("POI response checksum mismatch");
    if (signal?.aborted || !isCurrentLoad(cityId, gen)) return null;
    const json = await decompressBrotli(buffer);
    if (signal?.aborted || !isCurrentLoad(cityId, gen)) return null;
    const bundle = JSON.parse(json) as PoiBundle;
    if (bundle.meta.cityId !== cityId || bundle.meta.tier !== tier ||
        bundle.meta.entryCount !== bundle.entries.length) throw new Error("POI bundle identity mismatch");
    bundleRevisions.set(bundle, resource.activationRevision);
    clearLoadError(cityId, tier, gen);
    return bundle;
  } catch (err) {
    if (signal?.aborted || !isCurrentLoad(cityId, gen) || isAbortError(err)) {
      return null;
    }
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { source: "poiLoader.decompress", cityId },
    });
    setLoadError(cityId, tier, "parse", `Failed to parse POI bundle for ${cityId}`, gen);
    return null;
  }
}

export function syncMetaKey(cityId: string, tier: "strict" | "loose"): string {
  return tier === "loose" ? `${cityId}:loose` : cityId;
}

async function markCachedFallback(cityId: string, tier: "strict" | "loose", gen?: number): Promise<void> {
  if (!isCurrentLoad(cityId, gen)) return;
  const key = errorKey(cityId, tier);
  const existing = loadErrors.get(key);
  if (!existing) return;
  const meta = await db.poiSyncMeta.get(syncMetaKey(cityId, tier));
  if (!isCurrentLoad(cityId, gen)) return;
  if (meta) {
    loadErrors.set(key, { ...existing, hasCachedFallback: true });
    for (const fn of listeners) fn(loadErrors);
  }
}

export async function syncPoiBundle(
  cityId: string,
  bundle: PoiBundle,
  gen?: number,
): Promise<boolean> {
  const tier = bundle.meta.tier;
  const activationRevision = bundleRevisions.get(bundle);
  const metaKey = syncMetaKey(cityId, tier);
  const records = bundle.entries.map((e) => entryToRecord(e, cityId));

  const doWrite = () =>
    db.transaction("rw", [db.poiIndex, db.poiSyncMeta, db.poiTileGenerations], async () => {
      assertCurrentLoad(cityId, gen);
      const meta = await db.poiSyncMeta.get(metaKey);
      assertCurrentLoad(cityId, gen);
      const tiled = await db.poiTileGenerations.get(cityId);
      const highwater = Math.max(meta?.activationRevision ?? 0, tiled?.activationRevision ?? 0);
      if (highwater > (activationRevision ?? 0)) return false;
      if (activationRevision !== undefined && meta?.activationRevision === activationRevision &&
          meta.activeBundleHash !== bundle.meta.version) return false;
      if (meta?.activeBundleHash === bundle.meta.version && meta.activationRevision === activationRevision) {
        return false;
      }
      if (
        activationRevision === undefined &&
        meta?.bundleGeneratedAt &&
        bundle.meta.bundleGeneratedAt &&
        meta.bundleGeneratedAt > bundle.meta.bundleGeneratedAt
      ) {
        return false;
      }
      await db.poiIndex
        .where("[cityId+name]")
        .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
        .filter((r) => r.tier === tier)
        .delete();
      assertCurrentLoad(cityId, gen);
      // One bulkPut of a whole tier is a single main-thread task (Dexie clones
      // and keys every record synchronously): ~3,100 loose rows held the main
      // thread for ~80 ms at 4x CPU throttle. Chunks let the event loop run
      // between IndexedDB requests while the transaction stays open.
      for (let i = 0; i < records.length; i += POI_WRITE_CHUNK) {
        await db.poiIndex.bulkPut(records.slice(i, i + POI_WRITE_CHUNK));
        assertCurrentLoad(cityId, gen);
      }
      await db.poiSyncMeta.put({
        cityId: metaKey,
        activeBundleHash: bundle.meta.version,
        activationRevision,
        entryCount: records.length,
        installedAt: Date.now(),
        tier,
        sourcePbfTimestamp: bundle.meta.sourcePbfTimestamp,
        bundleGeneratedAt: bundle.meta.bundleGeneratedAt,
      });
      assertCurrentLoad(cityId, gen);
      return true;
    });

  let wrote: boolean;
  try {
    wrote = await doWrite();
  } catch (err) {
    if (err instanceof StalePoiLoadError) return false;
    if (!isQuotaError(err)) throw err;
    const evicted = await onQuotaNear();
    if (!isCurrentLoad(cityId, gen)) return false;
    if (evicted.length === 0) {
      setLoadError(cityId, tier, "quota", `Storage full — cannot load POI data for ${cityId}`, gen);
      reportError(new Error("POI sync quota exceeded, eviction freed nothing"), {
        context: { source: "poiLoader.sync", cityId, tier },
      });
      return false;
    }
    try {
      wrote = await doWrite();
    } catch (retryErr) {
      if (retryErr instanceof StalePoiLoadError) return false;
      setLoadError(cityId, tier, "quota", `Storage full — cannot load POI data for ${cityId}`, gen);
      reportError(retryErr instanceof Error ? retryErr : new Error(String(retryErr)), {
        context: { source: "poiLoader.sync.retry", cityId, tier },
      });
      return false;
    }
  }

  if (!wrote) return false;
  if (!isCurrentLoad(cityId, gen)) return false;
  clearLoadError(cityId, tier, gen);
  await notifyWriteGrew();
  return true;
}

export async function loadPoiBundle(
  cityId: string,
  options?: {
    includeLooseTier?: boolean;
    /** Category filtering hides rows locally; retain downloaded data for offline re-enabling. */
    retainLooseCache?: boolean;
  },
): Promise<boolean> {
  const gen = (loadGenerations.get(cityId) ?? 0) + 1;
  loadGenerations.set(cityId, gen);
  activeLoadControllers.get(cityId)?.controller.abort();
  const controller = new AbortController();
  activeLoadControllers.set(cityId, { gen, controller });

  try {
    if (!options?.includeLooseTier && !options?.retainLooseCache) {
      await clearLooseTier(cityId, gen);
    }
    if (!isCurrentLoad(cityId, gen)) return false;

    const strictBundle = await self.fetchPoiBundle(
      cityId,
      "strict",
      gen,
      controller.signal,
    );
    if (!isCurrentLoad(cityId, gen)) return false;

    if (!strictBundle) {
      await markCachedFallback(cityId, "strict", gen);
      return false;
    }

    let changed = await syncPoiBundle(cityId, strictBundle, gen);
    if (!changed) {
      await markCachedFallback(cityId, "strict", gen);
    }
    if (!isCurrentLoad(cityId, gen)) return false;

    if (options?.includeLooseTier) {
      const looseBundle = await self.fetchPoiBundle(
        cityId,
        "loose",
        gen,
        controller.signal,
      );
      if (!isCurrentLoad(cityId, gen)) return false;
      if (looseBundle) {
        const looseChanged = await syncPoiBundle(cityId, looseBundle, gen);
        if (!looseChanged) {
          await markCachedFallback(cityId, "loose", gen);
        }
        changed = changed || looseChanged;
      } else if (!loadErrors.has(errorKey(cityId, "loose"))) {
        await clearLooseTier(cityId, gen);
      }
    }

    return isCurrentLoad(cityId, gen) ? changed : false;
  } finally {
    if (activeLoadControllers.get(cityId)?.gen === gen) {
      activeLoadControllers.delete(cityId);
    }
  }
}

async function clearLooseTier(cityId: string, gen?: number): Promise<void> {
  const metaKey = syncMetaKey(cityId, "loose");
  const meta = await db.poiSyncMeta.get(metaKey);
  if (!meta || !isCurrentLoad(cityId, gen)) return;

  try {
    await db.transaction("rw", [db.poiIndex, db.poiSyncMeta], async () => {
      assertCurrentLoad(cityId, gen);
      await db.poiIndex
        .where("[cityId+name]")
        .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
        .filter((r) => r.tier === "loose")
        .delete();
      assertCurrentLoad(cityId, gen);
      await db.poiSyncMeta.delete(metaKey);
      assertCurrentLoad(cityId, gen);
    });
  } catch (err) {
    if (!(err instanceof StalePoiLoadError)) throw err;
  }
}

export async function clearPoiIndex(cityId?: string): Promise<void> {
  if (cityId) {
    await db.transaction("rw", [db.poiIndex, db.poiSyncMeta], async () => {
      await db.poiIndex
        .where("[cityId+name]")
        .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
        .delete();
      await db.poiSyncMeta.delete(syncMetaKey(cityId, "strict"));
      await db.poiSyncMeta.delete(syncMetaKey(cityId, "loose"));
    });
  } else {
    await db.transaction("rw", [db.poiIndex, db.poiSyncMeta], async () => {
      await db.poiIndex.clear();
      await db.poiSyncMeta.clear();
    });
  }
}

export function listenForSwUpdates(
  getCurrentCityId: () => string | null,
  _getIncludeLooseTier?: () => boolean,
  syncCurrentPoi: () => void | Promise<void> = async () => {
    const { syncPoi } = await import("../bootPoi.ts");
    syncPoi();
  },
): void {
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    const frontendCityId = getCurrentCityId();
    if (frontendCityId) {
      void Promise.resolve()
        .then(syncCurrentPoi)
        .catch((err) => {
          reportError(err instanceof Error ? err : new Error(String(err)), {
            context: { source: "poiLoader.swUpdate", cityId: frontendCityId },
          });
        });
    }
  });
}

export { poiCityIds } from "./poiCityMapping.ts";

registerEvictor("poiIndex", () => clearPoiIndex());
