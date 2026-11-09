/**
 * Map-only assets (the MapLibre chunk, its worker and the bundled label
 * glyphs) are kept out of the service-worker precache, so Text mode never
 * downloads them. Choosing Map fetches them right away instead, through the
 * service worker's cache-first rule, so the map still works offline later.
 */
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { LOCAL_GLYPHS_FONT } from "../map/mapConfig.ts";

/** Glyph ranges shipped under `public/glyphs/`. */
export const BUNDLED_GLYPH_RANGES = ["0-255", "256-511"] as const;

export function mapAssetUrls(): string[] {
  const font = encodeURIComponent(LOCAL_GLYPHS_FONT);
  return [
    workerUrl,
    ...BUNDLED_GLYPH_RANGES.map((range) => `/glyphs/${font}/${range}.pbf`),
  ];
}

/** Best-effort: a failure only means the map loads its assets on first use. */
export async function warmMapAssets(
  fetcher: typeof fetch = (...args) => fetch(...args),
  loadMapModule: () => Promise<unknown> = () => import("../map/maplibre.ts"),
): Promise<void> {
  await Promise.allSettled([
    loadMapModule(),
    ...mapAssetUrls().map((url) => fetcher(url, { credentials: "same-origin" })),
  ]);
}
