/**
 * Assets deliberately kept OUT of the Workbox precache.
 *
 * Workbox precaches every emitted `.js` at service-worker install, which
 * defeats code-splitting for anything the user will never open: all six
 * locale chunks were fetched and stored on every install so that five of
 * them could sit unused. The translations are split — they were just being
 * un-split by the precache glob.
 *
 * Anything listed here MUST have a CacheFirst rule in `runtimeCaching`, or
 * it becomes an asset that breaks in a tunnel instead of one that costs
 * bytes. `precache.test.ts` enforces that pairing.
 *
 * English stays precached: it is the fallback every other locale falls back
 * to, and the only one guaranteed to be needed.
 */
export const LAZY_LOCALE_CODES = [
  "lt",
  "pl",
  "be",
  "ru",
  "uk",
  "lv",
  "et",
  "sv",
  "nb",
  "fi",
] as const;

export type LazyLocaleCode = (typeof LAZY_LOCALE_CODES)[number];

/**
 * Map-only assets: the MapLibre chunk, its worker and the bundled label
 * glyphs. Text mode never needs them, so they are fetched when the user
 * chooses Map (or first opens a temporary map) and kept by a CacheFirst rule
 * from then on, which still makes the map usable offline.
 */
export const MAP_ONLY_PRECACHE_IGNORES: string[] = [
  "assets/vendor-map-*.js",
  "assets/maplibre-gl-worker-*.js",
  "glyphs/*/*.pbf",
];

export const precacheGlobIgnores: string[] = [
  "deployment-config.js",
  ...LAZY_LOCALE_CODES.map((code) => `assets/${code}-*.js`),
  // The privacy namespace: ~6 kB gzipped of English source plus one overlay
  // per locale, reachable only from the Settings privacy screen. Enumerated
  // rather than globbed with "privacy.*-*", so each pattern names one real
  // built file and can be checked against the runtime rule.
  "assets/privacy-*.js",
  ...LAZY_LOCALE_CODES.map((code) => `assets/privacy.${code}-*.js`),
  ...MAP_ONLY_PRECACHE_IGNORES,
];

/**
 * A representative built filename for a glob in {@link precacheGlobIgnores}.
 *
 * Vite appends a content hash, so the globs are prefix patterns. Tests use
 * this to check that a runtime rule actually covers each excluded glob
 * without having to run a build first.
 */
export function sampleAssetFor(glob: string): string {
  return glob.replace(/\*/g, "C0ffeeXY");
}
