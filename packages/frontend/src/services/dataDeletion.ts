import { db, TABLE_KIND, type PtnTableName } from "../db/index.ts";
import { useBadgeActivityStore } from "../stores/badgeActivityStore.ts";
import { useColorConfigStore } from "../stores/colorConfigStore.ts";
import { useDelayReportStore } from "../stores/delayReportStore.ts";
import { useFavoritesStore } from "../stores/favoritesStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useLineViewStore } from "../stores/lineViewStore.ts";
import { useMapObstaclesStore } from "../stores/mapObstaclesStore.ts";
import { useMapTapStore } from "../stores/mapTapStore.ts";
import { useMapViewportStore } from "../stores/mapViewportStore.ts";
import { usePrivacyChoicesStore } from "../stores/privacyChoicesStore.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";
import { useRoutingStore } from "../stores/routingStore.ts";
import { useRtStore } from "../stores/rtStore.ts";
import { useStopStore } from "../stores/stopStore.ts";
import { clearErrorBuffer } from "./errorReporter.ts";
import { LEGACY_FAVORITES_KEY } from "./favoritesMigration.ts";
import { stopDedupSweep } from "./geocoder/dedupCache.ts";
import { osrmClient } from "./osrmWasm.ts";
import { walkGraphClient } from "./walkGraphClient.ts";
import { clearWalkRouteCache } from "./walkRouteCache.ts";
import { stopRecentsSweep } from "./recents.ts";
import { stopStopUsageSweep } from "./stopUsage.ts";
import {clearCityArtifactMemory} from "./cityArtifactMemory.ts";
import {clearTransferArtifactMemory} from "./transfersArtifact.ts";
import {
  clearLocalReportsData,
  clearPersonalizationData,
  clearRecentsData,
  clearViewportData,
} from "./optionalStorageData.ts";

export {
  clearLocalReportsData,
  clearPersonalizationData,
  clearRecentsData,
  clearViewportData,
} from "./optionalStorageData.ts";
export {
  DELAY_REPORTS_STORAGE_KEY,
  MAP_VIEWPORT_STORAGE_KEY,
} from "./privacyStorageKeys.ts";

const PTN_RUNTIME_CACHE_NAMES = new Set([
  "api-departures-cache",
  "api-general-cache",
  "carto-style",
  "carto-tiles",
]);

/** Versioned runtime caches (see `src/sw/runtimeCaching.ts`). Matching the
 * family rather than one name also clears a cache left behind by an earlier
 * version. */
const PTN_RUNTIME_CACHE_PREFIXES = ["api-stops-cache"];

export interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

interface ServiceWorkerRegistrationLike {
  scope: string;
  unregister(): Promise<boolean>;
}

interface ServiceWorkerContainerLike {
  getRegistrations(): Promise<readonly ServiceWorkerRegistrationLike[]>;
}

function currentPtnScope(): string | undefined {
  try {
    return new URL(
      import.meta.env.BASE_URL || "/",
      globalThis.location.origin,
    ).href;
  } catch {
    return undefined;
  }
}

export function isPtnOwnedCacheName(
  name: string,
  ptnScope: string | undefined = currentPtnScope(),
): boolean {
  return (
    PTN_RUNTIME_CACHE_NAMES.has(name) ||
    PTN_RUNTIME_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    (ptnScope !== undefined && name === `workbox-precache-v2-${ptnScope}`)
  );
}

export function isPtnOwnedStorageKey(key: string): boolean {
  return /^ptn[-:._]/.test(key);
}

async function runEveryCleanup(
  cleanups: ReadonlyArray<() => unknown | Promise<unknown>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more PTN data stores could not be cleared");
  }
}

async function clearSavedPlacesData(
  storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage,
): Promise<void> {
  await db.savedLocations.clear();
  useFavoritesStore.setState({ favorites: [] });
  storage?.removeItem(LEGACY_FAVORITES_KEY);
}

/** Deletes rider-created history while preserving settings and public downloads. */
export async function deletePersonalHistory(
  storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage,
): Promise<void> {
  await runEveryCleanup([
    clearRecentsData,
    () => clearSavedPlacesData(storage),
    clearPersonalizationData,
    () => clearLocalReportsData(storage),
    () => clearViewportData(storage),
  ]);
}

export async function clearPtnCaches(
  cacheStorage: CacheStorageLike | undefined = globalThis.caches,
  ptnScope: string | undefined = currentPtnScope(),
): Promise<string[]> {
  if (!cacheStorage) return [];
  const owned = (await cacheStorage.keys()).filter((name) =>
    isPtnOwnedCacheName(name, ptnScope),
  );
  await Promise.all(owned.map((name) => cacheStorage.delete(name)));
  return owned;
}

export async function unregisterPtnServiceWorker(
  serviceWorkers: ServiceWorkerContainerLike | undefined =
    globalThis.navigator?.serviceWorker,
): Promise<void> {
  if (!serviceWorkers) return;
  const expectedScope = new URL(
    import.meta.env.BASE_URL,
    globalThis.location.origin,
  ).href;
  const registrations = await serviceWorkers.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) => new URL(registration.scope).href === expectedScope)
      .map((registration) => registration.unregister()),
  );
}

function downloadedTableNames(): PtnTableName[] {
  return (Object.entries(TABLE_KIND) as Array<[PtnTableName, string]>)
    .filter(([, kind]) => kind === "server-derived" || kind === "retained-download")
    .map(([name]) => name);
}

export interface ClearDownloadedDataOptions {
  cacheStorage?: CacheStorageLike;
  /** Test seam; production derives this from Vite's configured base URL. */
  ptnScope?: string;
  /** Test seam; production releases the active routing engine first. */
  stopDownloadedRuntime?: () => Promise<void>;
}

/** Clears only reproducible public/operator data and PTN-owned browser caches. */
export async function clearDownloadedData(
  opts: ClearDownloadedDataOptions = {},
): Promise<void> {
  clearTransferArtifactMemory();
  clearCityArtifactMemory();
  const stopRuntime =
    opts.stopDownloadedRuntime ??
    (async () => {
      await useGtfsDataStore.getState().reset();
      useStopStore.getState().reset();
      useStopStore.setState({ stops: [], hydrated: false });
      useBadgeActivityStore.getState().clear();
    });
  await stopRuntime();
  await runEveryCleanup([
    ...downloadedTableNames().map(
      (name) => () => db.table(name).clear(),
    ),
    async () => {await (await import("./walkGraphStore.ts")).clearWalkGraphStore();},
    () => clearPtnCaches(opts.cacheStorage, opts.ptnScope),
  ]);
}

function resetInMemoryStores(): void {
  useGuidanceStore.getState().reset();
  useRoutingStore.setState({
    results: [],
    loading: false,
    error: null,
    engineError: null,
    engineFailureKind: null,
    origin: null,
    destination: null,
    backendAssist: false,
  });
  useRtStore.getState().unsubscribeAll();
  useStopStore.getState().reset();
  useStopStore.setState({ stops: [], hydrated: false });
  useFavoritesStore.setState({ favorites: [] });
  useDelayReportStore.setState({ reports: [] });
  useMapTapStore.getState().clear();
  useMapViewportStore.setState({ bounds: null, zoom: null });
  useMapObstaclesStore.setState({ obstacles: new Map() });
  useLineViewStore.getState().hideLine();
  useBadgeActivityStore.getState().clear();
  useColorConfigStore.getState().reset();
  usePrivacyChoicesStore.getState().reset();
  usePrivacyStore.getState().reset();
  clearErrorBuffer();
}

async function stopPtnRuntime(): Promise<void> {
  stopRecentsSweep();
  stopStopUsageSweep();
  stopDedupSweep();
  useRtStore.getState().unsubscribeAll();
  osrmClient.destroy();
  walkGraphClient.destroy();
  clearWalkRouteCache();
  await useGtfsDataStore.getState().reset();
  await unregisterPtnServiceWorker();
}

function removePtnStorageKeys(storage: Storage | undefined): void {
  if (!storage) return;
  const owned: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && isPtnOwnedStorageKey(key)) owned.push(key);
  }
  for (const key of owned) storage.removeItem(key);
}

export interface ResetPtnOptions {
  localStorage?: Storage;
  sessionStorage?: Storage;
  cacheStorage?: CacheStorageLike;
  /** Test seam; production derives this from Vite's configured base URL. */
  ptnScope?: string;
  stopRuntime?: () => Promise<void>;
  resetMemory?: () => void;
  reload?: () => void;
}

/** Removes PTN completely without touching unrelated origin storage or caches. */
export async function resetPtnCompletely(
  opts: ResetPtnOptions = {},
): Promise<void> {
  await (opts.stopRuntime ?? stopPtnRuntime)();
  (opts.resetMemory ?? resetInMemoryStores)();
  await db.delete();
  await (await import("./walkGraphStore.ts")).clearWalkGraphStore();
  removePtnStorageKeys(opts.localStorage ?? globalThis.localStorage);
  removePtnStorageKeys(opts.sessionStorage ?? globalThis.sessionStorage);
  await clearPtnCaches(opts.cacheStorage, opts.ptnScope);
  (opts.reload ?? (() => globalThis.location.reload()))();
}
