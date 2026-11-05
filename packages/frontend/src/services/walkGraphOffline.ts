/** Last native-validated graph per city. Failed downloads/decodes never replace
 * this record. Revision checks and bytes commit together across browser tabs. */
import {registerEvictor} from "./storagePolicy.ts";
import {clearWalkGraphStore, getStoredWalkGraph, putStoredWalkGraph, type WalkGraphArtifactRecord} from "./walkGraphStore.ts";
import {artifactSha256, discoverWalkGraph, fetchWalkGraphBytes, type WalkGraphResource} from "./walkGraphResource.ts";

registerEvictor("walkGraphArtifacts", clearWalkGraphStore);

export async function readLastGoodGraph(cityId: string): Promise<WalkGraphArtifactRecord | null> {
  const record = await getStoredWalkGraph(cityId);
  if (!record || record.resource.cityId !== cityId ||
      record.compressed.byteLength !== record.resource.bytes ||
      await artifactSha256(record.compressed) !== record.resource.sha256) return null;
  return record;
}

/** Call only after the native constructor and city check both succeed. A cache
 * failure must not prevent use of an already validated in-memory graph. */
export async function rememberGoodGraph(resource: WalkGraphResource, compressed: ArrayBuffer): Promise<boolean> {
  if (compressed.byteLength !== resource.bytes ||
      await artifactSha256(compressed) !== resource.sha256) throw new Error("invalid offline graph bytes");
  if (!Number.isSafeInteger(resource.revision) || resource.revision < 1) throw new Error("invalid offline graph revision");
  return putStoredWalkGraph({cityId: resource.cityId, resource, compressed, installedAt: Date.now()});
}

export interface WalkGraphCandidate {
  compressed: ArrayBuffer;
  resource?: WalkGraphResource;
}

export interface WalkGraphArtifacts {
  load(cityId: string, signal: AbortSignal): Promise<WalkGraphCandidate | null>;
  fallback(cityId: string): Promise<WalkGraphCandidate | null>;
  remember(candidate: WalkGraphCandidate): Promise<void>;
}

/** Discovery failures may use the last fully validated local graph. A candidate
 * that fails native validation is handled separately by the worker host. */
export function managedWalkGraphArtifacts(fetcher: typeof fetch): WalkGraphArtifacts {
  const fallback = async (cityId: string): Promise<WalkGraphCandidate | null> => {
    try {
      const cached = await readLastGoodGraph(cityId);
      return cached ? {compressed: cached.compressed, resource: cached.resource} : null;
    } catch { return null; }
  };
  return {
    fallback,
    async load(cityId, signal) {
      try {
        const discovery = await discoverWalkGraph(cityId, fetcher, signal);
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        const previous = await fallback(cityId);
        if (discovery.kind === "unavailable") return previous;
        if (previous?.resource && (
          previous.resource.revision > discovery.resource.revision ||
          (previous.resource.revision === discovery.resource.revision &&
           previous.resource.release !== discovery.resource.release)
        )) return previous;
        const compressed = await fetchWalkGraphBytes(discovery.resource, fetcher, signal);
        return {compressed, resource: discovery.resource};
      } catch (error) {
        if (signal.aborted) throw error;
        const cached = await fallback(cityId);
        if (cached) return cached;
        throw error;
      }
    },
    async remember(candidate) {
      if (!candidate.resource) throw new Error("missing managed graph identity");
      try { await rememberGoodGraph(candidate.resource, candidate.compressed); }
      catch { /* quota/private-mode failure must not interrupt valid guidance */ }
    },
  };
}
