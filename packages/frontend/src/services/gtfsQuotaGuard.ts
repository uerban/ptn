const SHAPES_THRESHOLD = 0.7;
// Stops payloads are ~1 MB gzipped (Vilnius scale) up to several MB on
// Oslo-scale cities. Use a slightly higher threshold than shapes — losing
// the in-memory render path on a near-but-not-over-quota PWA is a worse UX
// than letting bulkPut throw once and log; the upstream try/catch in
// stopStore handles the throw gracefully.
const STOPS_THRESHOLD = 0.85;
let shapesCached: boolean | null = null;
let stopsCached: boolean | null = null;

async function estimateRatio(): Promise<number | null> {
  const storage = (navigator as unknown as {
    storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> };
  }).storage;
  if (!storage?.estimate) {
    console.warn("[gtfsQuotaGuard] navigator.storage.estimate unavailable — assuming headroom");
    return null;
  }
  try {
    const { usage, quota } = await storage.estimate();
    if (!usage || !quota) {
      console.warn("[gtfsQuotaGuard] storage.estimate returned no usage/quota — assuming headroom");
      return null;
    }
    return usage / quota;
  } catch (err) {
    console.warn("[gtfsQuotaGuard] storage.estimate failed — assuming headroom", err);
    return null;
  }
}

/**
 * Generic headroom check, cached per-threshold-bucket so repeated upserts
 * don't repeatedly query navigator.storage. Returns true when the estimate
 * is unavailable — the assumption is that we'd rather try and let the
 * caller's error path handle a quota throw than silently skip writes on
 * browsers without storage.estimate support.
 */
export async function hasIdbHeadroom(threshold = 0.85): Promise<boolean> {
  const ratio = await estimateRatio();
  if (ratio === null) return true;
  return ratio <= threshold;
}

export async function shouldWriteShapes(): Promise<boolean> {
  if (shapesCached !== null) return shapesCached;
  shapesCached = await hasIdbHeadroom(SHAPES_THRESHOLD);
  return shapesCached;
}

export async function shouldWriteStops(): Promise<boolean> {
  if (stopsCached !== null) return stopsCached;
  stopsCached = await hasIdbHeadroom(STOPS_THRESHOLD);
  return stopsCached;
}

export function resetQuotaGuardForSync(): void {
  shapesCached = null;
  stopsCached = null;
}
