/**
 * Fetch and decode the offline city micromap.
 *
 * The artifact is a static asset (`/micromap/<city>.micromap.br`) shipped with
 * the app, like the POI corpus — the fetch is same-origin, carries no user
 * position, and is cached by the service worker, so a micromap that has been
 * loaded once keeps working with no network at all.
 *
 * A missing artifact is NOT an error: cities we have not generated one for
 * simply fall back to the GTFS corridors already drawn in every local map
 * mode. That fallback is why nothing here reports to the error reporter for a
 * 404 — an absent micromap is a normal state, not a fault.
 */
import { useCallback, useSyncExternalStore } from "react";
import { decompressBrotli } from "./brotliDecode.ts";
import { reportError } from "./errorReporter.ts";
import {
  parseMicromapArtifact,
  type MicromapArtifact,
} from "../map/micromap/types.ts";

const cache = new Map<string, MicromapArtifact | null>();
const inFlight = new Map<string, Promise<MicromapArtifact | null>>();

/**
 * What the minimal map is doing for a city, so the map can say so instead of
 * silently showing nothing:
 *
 * - `loading`: the artifact is being fetched or decoded;
 * - `ready`: drawn, fetched from the network;
 * - `cached`: drawn from the copy already on this device;
 * - `absent`: the city has no minimal map (a normal state);
 * - `failed`: the artifact was unreachable or malformed while online;
 * - `offline`: not on this device yet and there is no connection.
 *
 * Transit routes and stops never wait for any of these.
 */
export type MicromapState =
  | "loading"
  | "ready"
  | "cached"
  | "absent"
  | "failed"
  | "offline";

/** The service worker's cache for micromap artifacts (`sw/runtimeCaching.ts`). */
export const MICROMAP_CACHE = "micromap-artifacts";

const states = new Map<string, MicromapState>();
const stateListeners = new Set<() => void>();

function setState(cityId: string, state: MicromapState): void {
  if (states.get(cityId) === state) return;
  states.set(cityId, state);
  for (const listener of stateListeners) {
    try {
      listener();
    } catch {
      // One failing subscriber must not stop the others.
    }
  }
}

/** Current state for `cityId`, or `undefined` before any load was asked for. */
export function getMicromapState(cityId: string): MicromapState | undefined {
  return states.get(cityId);
}

export function subscribeMicromapState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** React binding of `getMicromapState`. */
export function useMicromapState(cityId: string): MicromapState | undefined {
  const get = useCallback(() => getMicromapState(cityId), [cityId]);
  return useSyncExternalStore(subscribeMicromapState, get, get);
}

/** Whether the service worker already holds this city's artifact. Asks
 * `has` first: `open` would create the cache. */
async function isCachedOnDevice(cityId: string): Promise<boolean> {
  try {
    const storage = globalThis.caches;
    if (!storage || !(await storage.has(MICROMAP_CACHE))) return false;
    const cache = await storage.open(MICROMAP_CACHE);
    return (await cache.match(micromapUrl(cityId))) !== undefined;
  } catch {
    return false;
  }
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function micromapUrl(cityId: string): string {
  return `/micromap/${cityId}.micromap.br`;
}

/**
 * Decode the artifact body, whoever compressed it.
 *
 * Production nginx serves `.br` artifacts as opaque bytes with no
 * `Content-Encoding` (see `nginx/micromap-static.inc`, same contract as the
 * POI corpus), so the client decompresses. Some static servers — vite's dev
 * server, and any CDN that infers an encoding from the extension — instead
 * declare `Content-Encoding: br`, in which case `fetch` has already
 * decompressed and a second pass would fail. JSON always starts with `{`,
 * which is how the two cases are told apart.
 */
async function readArtifactBody(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x7b) return new TextDecoder().decode(bytes);
  return decompressBrotli(buffer);
}

async function fetchMicromap(
  cityId: string,
): Promise<MicromapArtifact | null> {
  const response = await fetch(micromapUrl(cityId));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`micromap HTTP ${response.status}`);

  const artifact = parseMicromapArtifact(
    JSON.parse(await readArtifactBody(await response.arrayBuffer())),
  );
  if (!artifact) {
    throw new Error(`micromap for ${cityId} failed validation`);
  }
  if (artifact.cityId !== cityId) {
    // A mismatched id means the deploy is serving another city's file; drawing
    // it would silently show the wrong place.
    throw new Error(
      `micromap city mismatch: asked ${cityId}, got ${artifact.cityId}`,
    );
  }
  return artifact;
}

/**
 * Load a city's micromap, memoized per city (including the negative result, so
 * a city without an artifact is not re-fetched on every pan). Returns `null`
 * when there is nothing to draw.
 *
 * Deliberately takes NO abort signal. The load is shared between every caller
 * for a city, so one caller going away must not cancel it for the others —
 * under React StrictMode's mount/unmount/remount the first mount's cleanup
 * would otherwise abort the very fetch the second mount is waiting on, and the
 * micromap silently never appeared. A caller that no longer cares just ignores
 * the resolved value; the artifact is ~40 KB, so a wasted load costs nothing
 * worth a cancellation path.
 */
export async function loadMicromap(
  cityId: string,
): Promise<MicromapArtifact | null> {
  if (cache.has(cityId)) return cache.get(cityId) ?? null;
  const pending = inFlight.get(cityId);
  if (pending) return pending;

  setState(cityId, "loading");
  const promise = isCachedOnDevice(cityId)
    .then(async (cachedOnDevice) => {
      const artifact = await fetchMicromap(cityId);
      cache.set(cityId, artifact);
      setState(
        cityId,
        artifact === null ? "absent" : cachedOnDevice ? "cached" : "ready",
      );
      return artifact;
    })
    .catch((error: unknown) => {
      // Not on this device and no connection: expected, report nothing.
      if (isOffline()) {
        setState(cityId, "offline");
        return null;
      }
      setState(cityId, "failed");
      // Malformed or unreachable: remember nothing (a later attempt may
      // succeed) but tell the reporter, since this one IS a fault.
      reportError(error instanceof Error ? error : new Error(String(error)), {
        context: { source: "micromapLoader", cityId },
      });
      return null;
    })
    .finally(() => {
      inFlight.delete(cityId);
    });

  inFlight.set(cityId, promise);
  return promise;
}

/** Test seam — drops the memoized artifacts and states. */
export function resetMicromapCache(): void {
  cache.clear();
  inFlight.clear();
  states.clear();
}
