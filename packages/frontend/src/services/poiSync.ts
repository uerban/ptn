import type { PoiFetchMode, PoiTileBounds, TileAnchor } from "@pt/shared";
import type { TileLoader } from "./tileLoader.ts";
import type { CityPoiTiling } from "./poiManifest.ts";
import { cancelPoiBundleLoads } from "./poiLoader.ts";

let syncEpoch = 0;

export interface MakeTileLoaderOpts {
  cityId: string;
  edgeKm: number;
  anchor: TileAnchor;
  bundleSha256: string;
  /** Client-serving grid bounds — threaded to `createTileLoader` for the
   * prefetch/padding/decoy tile-defense pool. */
  tileBounds: PoiTileBounds;
}

export interface SyncPoiDeps {
  loadBundle: (cityId: string) => Promise<void>;
  makeTileLoader: (opts: MakeTileLoaderOpts) => TileLoader;
  resolveMode: (cityId: string) => PoiFetchMode;
  getTiling: (cityId: string) => Promise<CityPoiTiling | null>;
  poiCityIds: (frontendCityId: string) => string[];
  getActiveCityId: () => string;
  /** Whether the user opted into the loose POI tier. The backend tiles the
   * STRICT tier only ("Phase 1 tiles the strict tier only; the
   *  loose tier stays whole-bundle"), so in lazy-tile mode the loose tier is NOT
   *  available via per-tile loaders and must be delivered as a whole-bundle. */
  includeLooseTier: boolean;
  /** Dispose any tileLoader(s) constructed for a prior sync, before new ones. */
  disposePrior: () => void;
  /**
 * Optional breadcrumb fired when entering server-side mode. PURE observability — never mutates
 * a table. Never required.
 */
  onServerSide?: (cityId: string) => void;
  /**
 * Optional OPT-IN corpus purge on entering server-side mode (defence-in-depth). DEFAULT ABSENT
 * — the residency invariant (no network fetch) holds without it. When wired (e.g. to
 * clearPoiIndex) it deletes the server-derived corpus only; it NEVER touches user tables.
 */
  purgeCorpus?: () => Promise<void>;
}

/**
 * Owns the fetch-mode dispatch, 1→N POI-city fan-out, the await-then-recheck guard, and
 * prior-tileLoader disposal. main.tsx wires real deps.
 */
export async function syncPoiForCity(frontendCityId: string, deps: SyncPoiDeps): Promise<void> {
  const epoch = ++syncEpoch;
  cancelPoiBundleLoads();
  const mode = deps.resolveMode(frontendCityId);
  const cityIds = deps.poiCityIds(frontendCityId);
  const isCurrent = () =>
    epoch === syncEpoch && deps.getActiveCityId() === frontendCityId;

  // Dispose any tileLoader(s) from a prior sync BEFORE the mode dispatch. A
  // lazy→eager swap must not leak the prior lazy loaders (their AbortControllers
  // and debounce timers stay alive otherwise). Every branch disposes the prior
  // registry (spec AC-13). Disposing an empty registry (eager→eager) is
  // a harmless no-op, so a single top-of-function call covers every swap.
  deps.disposePrior();

  if (mode === "server-side") {
    // Data residency: download NO corpus. The self-hosted geocoder serves
    // search; the client holds no POI bundle/tiles. Saved/recent user data is
    // never read or written on this path. Prior tile loaders already disposed
    // above. ( residency invariant.)
    if (!isCurrent()) return;
    deps.onServerSide?.(frontendCityId); // observability ONLY — no table mutation
    await deps.purgeCorpus?.();           // OPT-IN corpus purge (default absent)
    return; // ← no loadBundle, no makeTileLoader, no fetchPoiBundle
  }

  if (mode === "eager-bundle") {
    for (const cityId of cityIds) {
      if (!isCurrent()) return;
      await deps.loadBundle(cityId);
      if (!isCurrent()) return;
    }
    return;
  }

  // lazy-tile: construct one tileLoader per POI cityId.
  for (const cityId of cityIds) {
    if (!isCurrent()) return;
    const tiling = await deps.getTiling(cityId);
    // Re-check the active frontend city after the await — a city change during the await must not
    // construct against the stale city.
    if (!isCurrent()) return;
    if (!tiling) {
      // Manifest says not tiled → fall back to the whole-bundle path for this
      // city. That fallback already carries the loose tier when the user opted
      // in (main.tsx wires loadBundle → loadPoiBundle(..., {includeLooseTier})),
      // so do NOT additionally load loose below — it would double-fetch.
      await deps.loadBundle(cityId);
      if (!isCurrent()) return;
      continue;
    }
    deps.makeTileLoader({
      cityId,
      edgeKm: tiling.edgeKm,
      anchor: tiling.anchor,
      bundleSha256: tiling.bundleSha256,
      tileBounds: tiling.tileBounds,
    });
    // The strict tier ships as per-tile loaders above. The loose tier is NEVER
    // tiled, so when the user opted in, deliver it via the
    // whole-bundle for this POI cityId. The strict overlap with tiles is
    // harmless — search/dedup keys on `osmId ?? id`, making it idempotent.
    if (deps.includeLooseTier) {
      await deps.loadBundle(cityId);
      // A city change during the loose-bundle await must not keep syncing the
      // stale city's remaining members (mirror the post-getTiling guard).
      if (!isCurrent()) return;
    }
  }
}

// Active per-POI-city tile loaders for the current frontend city (lazy-tile).
// Single source of truth shared by main.tsx (constructs/disposes) and Search.tsx
// (reads, to drive viewport-first search prefetch).
const activeTileLoaders = new Map<string, TileLoader>();

export function registerActiveTileLoader(cityId: string, loader: TileLoader): void {
  activeTileLoaders.set(cityId, loader);
}
export function getActiveTileLoader(cityId: string): TileLoader | undefined {
  return activeTileLoaders.get(cityId);
}
export function disposeActiveTileLoaders(): void {
  for (const loader of activeTileLoaders.values()) loader.dispose();
  activeTileLoaders.clear();
}
