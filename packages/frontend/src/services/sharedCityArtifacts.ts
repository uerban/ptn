import {db} from "../db/index.ts";
export type SharedArtifactKind = "transfers" | "shapes";
const table = (kind: SharedArtifactKind) => kind === "transfers" ? db.offlineTransfers : db.cityShapes;

function store(kind: SharedArtifactKind, hash: string, bytes: Uint8Array): Promise<void> {
  return db.transaction("rw", table(kind), db.sharedArtifactMetadata, async () => {
    await table(kind).put({hash, bytes});
    await db.sharedArtifactMetadata.put({key: kind + ':' + hash, kind,
      hash, sizeBytes: bytes.byteLength, lastUsedAt: Date.now()});
  });
}

// Keep two verified raw artifacts per kind so active consumers can share bytes
// while their optional disk write is pending. No decoded inactive-city data.
const memory = new Map<string, Uint8Array>();
const writes = new Map<string, Promise<unknown>>();
const inFlight = new Map<string, Promise<Uint8Array>>();
const signalIds = new WeakMap<AbortSignal, number>();
let nextSignalId = 0;
let epoch = 0;
interface ArtifactReferences {artifactKey?: string; transfersHash?: string; shapesHash?: string}
const references = new Set<ArtifactReferences>();

/** Active contexts and explicit downloads hold references even before their
 * durable metadata is published. Release does not retain decoded city data. */
export function holdSharedArtifactReferences(value: ArtifactReferences): () => void {
  references.add(value);
  return () => { references.delete(value); trimMemory(); };
}

export function sharedArtifactReferences(): ArtifactReferences[] { return [...references]; }

function trimMemory(): void {
  for (const kind of ["transfers", "shapes"] as const) {
    const protectedKeys = new Set([...references].flatMap(row => {
      const hash = kind === "transfers" ? row.transfersHash : row.shapesHash;
      return hash ? [kind + ':' + hash] : [];
    }));
    const keys = [...memory.keys()].filter(key => key.startsWith(kind + ':'));
    for (const key of keys) {
      if (keys.filter(value => memory.has(value)).length <= Math.max(2, protectedKeys.size)) break;
      if (!protectedKeys.has(key)) memory.delete(key);
    }
  }
}

export function clearSharedArtifactMemory(): void { memory.clear(); epoch++; }
export function sharedArtifactEpoch(): number { return epoch; }

function remember(kind: SharedArtifactKind, hash: string, bytes: Uint8Array): void {
  const key = kind + ':' + hash;
  memory.delete(key);
  memory.set(key, bytes);
  trimMemory();
}

/** Explicit offline pinning waits for durability and verifies content. Normal
 * map/index/engine readiness does not depend on this optional cache write. */
export async function ensureSharedArtifactStored(kind: SharedArtifactKind, hash: string): Promise<void> {
  const release = holdSharedArtifactReferences(kind === "transfers" ? {transfersHash: hash} : {shapesHash: hash});
  try {
    await writes.get(kind + ":" + hash);
    const cached = await table(kind).get(hash);
    if (cached && await verified(cached.bytes, hash)) return;
    const resident = memory.get(kind + ":" + hash);
    if (resident && await verified(resident, hash)) {
      // A completed GC or a damaged disk record must not make a verified active
      // artifact impossible to pin. Only this explicit save waits for repair.
      await store(kind, hash, resident);
      return;
    }
    throw new Error(`${kind} artifact is not verified on this device`);
  } finally { release(); }
}

/** Verified raw sidecars are shared by content identity. Geometry decoding and
 * planner transfer decoding remain with the active consumers. */
export async function fetchSharedArtifactBytes(
  kind: SharedArtifactKind, url: string,
  expectedHash: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  opts.signal?.throwIfAborted();
  let signalId = 0;
  if (opts.signal) {
    if (!signalIds.has(opts.signal)) signalIds.set(opts.signal, ++nextSignalId);
    signalId = signalIds.get(opts.signal)!;
  }
  const key = JSON.stringify([kind, expectedHash, new URL(url, window.location.origin).href, signalId, epoch]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = readSharedArtifactBytes(kind, url, expectedHash, opts).finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

async function readSharedArtifactBytes(kind: SharedArtifactKind, url: string, expectedHash: string, opts: {signal?: AbortSignal}): Promise<Uint8Array> {
  opts.signal?.throwIfAborted();
  const run = epoch;
  const resident = memory.get(kind + ":" + expectedHash);
  if (resident) { remember(kind, expectedHash, resident); return resident; }
  // Prepared cities retain verified, content-addressed sidecars offline.
  const cached = await table(kind).get(expectedHash).catch(() => undefined);
  if (cached && await verified(cached.bytes, expectedHash)) {
    opts.signal?.throwIfAborted();
    if (run === epoch) remember(kind, expectedHash, cached.bytes);
    if (run === epoch) void db.sharedArtifactMetadata.put({key: kind + ':' + expectedHash, kind,
      hash: expectedHash, sizeBytes: cached.bytes.byteLength, lastUsedAt: Date.now()}).catch(() => {});
    return cached.bytes;
  }
  const absolute = new URL(url, window.location.origin).toString();
  // F9: callers key the signal to the city/init generation so a city switch
  // mid-download aborts the transfer instead of resolving into stale state.
  const res = await fetch(absolute, { signal: opts.signal });
  if (!res.ok) {
    throw new Error(`${kind} artifact HTTP ${res.status} for ${url}`);
  }
  const buffer = await res.arrayBuffer();
  const hash = await sha256Hex(buffer);
  if (hash !== expectedHash) {
    // Truncate hash for grep brevity; full values would dominate the log line.
    throw new Error(
      `${kind} artifact hash mismatch for ${url}: got ${hash.slice(0, 8)}…, expected ${expectedHash.slice(0, 8)}…`,
    );
  }
  const bytes = new Uint8Array(buffer);
  opts.signal?.throwIfAborted();
  if (run === epoch) {
    remember(kind, expectedHash, bytes);
    const write = store(kind, expectedHash, bytes);
    writes.set(kind + ":" + expectedHash, write);
    void write.catch(() => {}).finally(() => {
      if (writes.get(kind + ":" + expectedHash) === write) writes.delete(kind + ":" + expectedHash);
    });
    // A late optional sidecar can arrive after catalog publication/collection.
    // Collect again after storage, outside both readiness and this write promise.
    void write.then(async () => {
      const {collectCityArtifacts} = await import("./cityArtifacts.ts");
      await collectCityArtifacts(null);
    }).catch(() => {});
  }
  return bytes;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verified(bytes: Uint8Array, hash: string): Promise<boolean> {
  if (Object.prototype.toString.call(bytes) !== "[object Uint8Array]") return false;
  try { return await sha256Hex(bytes.slice().buffer as ArrayBuffer) === hash; }
  catch { return false; }
}
