/**
 * Whether the map-only assets are already on this device. Text mode never
 * downloads them (they are outside the precache), so the first temporary map
 * discloses that download before it starts.
 */

/** The service worker's cache-first map-assets cache (`sw/runtimeCaching.ts`). */
export const MAP_ASSETS_CACHE = "map-assets";

const MAP_CHUNK = /\/assets\/vendor-map-[A-Za-z0-9_-]+\.js$/;

export async function mapAssetsCached(
  storage: CacheStorage | undefined = globalThis.caches,
): Promise<boolean> {
  try {
    // `open` would create the cache, so ask first.
    if (!storage || !(await storage.has(MAP_ASSETS_CACHE))) return false;
    const keys = await (await storage.open(MAP_ASSETS_CACHE)).keys();
    return keys.some((request) => MAP_CHUNK.test(new URL(request.url).pathname));
  } catch {
    return false;
  }
}
