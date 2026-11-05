/**
 * Two-phase, privacy-safe idle prewarm. Map-decoupled (injected handle) so it is unit-testable
 * without WebGL.
 */
export const MIN_DOTS_TO_PREWARM = 3;        // a stray boundary singleton must not trigger a fetch
const PREWARM_BYTE_BUDGET = 8_000_000;       // per-session cap on prewarm downloads

let phase1Done = false;
let lastWarmed: string | null = null;        // `${bundleHash}/${tileCoords}`
let bytesSpent = 0;
let lastFetchBytes = 0;                      // last tile size; used as next-tile estimate for budget guard

export function __resetPrewarmForTests(): void { phase1Done = false; lastWarmed = null; bytesSpent = 0; lastFetchBytes = 0; }

export interface Phase1Deps { warmupBrotli: () => Promise<void> | void; warmManifest: () => Promise<void> | void; importReadPath: () => Promise<unknown> | void; }
export async function prewarmPhase1(d: Phase1Deps): Promise<void> {
  if (phase1Done) return;
  phase1Done = true;
  await Promise.allSettled([Promise.resolve(d.importReadPath()), Promise.resolve(d.warmupBrotli()), Promise.resolve(d.warmManifest())]);
}

export interface MapHandle {
  getLayer: (id: string) => unknown | undefined;
  queryRenderedFeatures: (opts: { layers: string[] }) => unknown[];
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
}
export interface Phase2Deps {
  fetchTile: (bundleHash: string, tileCoords: string) => Promise<number>; // returns bytes downloaded (0 if cached)
  resolveCoords: (lat: number, lng: number) => string | null;
  bundleHash: () => string | null;
  dotLayerId?: string;
}
export async function prewarmPhase2(map: MapHandle, deps: Phase2Deps): Promise<void> {
  // Stop if already over budget, or if the last tile's size predicts we'd exceed it.
  if (bytesSpent >= PREWARM_BYTE_BUDGET) return;
  if (lastFetchBytes > 0 && bytesSpent + lastFetchBytes > PREWARM_BYTE_BUDGET) return;
  const layerId = deps.dotLayerId ?? "stops-dot";
  if (!map.getLayer(layerId)) return;
  if (map.queryRenderedFeatures({ layers: [layerId] }).length < MIN_DOTS_TO_PREWARM) return;
  const hash = deps.bundleHash();
  if (!hash) return;
  const { lat, lng } = map.getCenter();
  const coords = deps.resolveCoords(lat, lng);
  if (!coords) return;
  const key = `${hash}/${coords}`;
  if (key === lastWarmed) return;
  lastWarmed = key;
  const fetched = await deps.fetchTile(hash, coords);
  bytesSpent += fetched;
  lastFetchBytes = fetched;
}
