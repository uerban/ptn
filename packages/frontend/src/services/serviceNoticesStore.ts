import { useEffect } from "react";
import { create } from "zustand";
import { isServiceNoticesBody, type RoutingBundleNoticesArtifact, type ServiceNotice } from "@pt/shared";
import { db } from "../db/index.ts";

/**
 * Service notices of the served generation, advertised on the raptor-bundle
 * response as `X-PT-Notices-Artifact-{Url,Hash,Size}`. A new generation is the
 * only invalidation: same hash ⇒ keep, other hash ⇒ refetch, no header ⇒ none.
 * Notices are decoration: every failure here is swallowed and routing goes on.
 */

interface ServiceNoticesState {
  byCity: Record<string, ServiceNotice[]>;
}

export const useServiceNoticesStore = create<ServiceNoticesState>(() => ({ byCity: {} }));

const EMPTY: ServiceNotice[] = [];

/** Notices of a city as last stored (read once from IndexedDB, so they work offline). */
export function useCityNotices(cityId: string): ServiceNotice[] {
  const loaded = useServiceNoticesStore(state => cityId in state.byCity);
  useEffect(() => {
    if (!loaded) void loadServiceNotices(cityId);
  }, [cityId, loaded]);
  return useServiceNoticesStore(state => state.byCity[cityId] ?? EMPTY);
}

function publish(cityId: string, notices: ServiceNotice[]): void {
  useServiceNoticesStore.setState(state => ({ byCity: { ...state.byCity, [cityId]: notices } }));
}

export function readNoticesArtifactHeaders(headers: Headers): RoutingBundleNoticesArtifact | undefined {
  const url = headers.get("x-pt-notices-artifact-url");
  const hash = headers.get("x-pt-notices-artifact-hash");
  const sizeRaw = headers.get("x-pt-notices-artifact-size");
  if (!url || !hash || !sizeRaw) return undefined;
  const sizeBytes = Number(sizeRaw);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
  return { url, hash, sizeBytes };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const inFlight = new Map<string, Promise<void>>();

/** Bring the stored notices in line with what a network-validated bundle response advertised. */
export function syncServiceNotices(
  cityId: string,
  artifact: RoutingBundleNoticesArtifact | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = `${cityId}:${artifact?.hash ?? ""}`;
  const ongoing = inFlight.get(key);
  if (ongoing) return ongoing;
  const work = doSync(cityId, artifact, fetchImpl)
    .catch(error => { console.warn(`[serviceNotices] ${cityId}: notices unavailable`, error); })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, work);
  return work;
}

async function doSync(cityId: string, artifact: RoutingBundleNoticesArtifact | undefined, fetchImpl: typeof fetch): Promise<void> {
  if (!artifact) {
    await db.serviceNotices.delete(cityId);
    publish(cityId, EMPTY);
    return;
  }
  const stored = await db.serviceNotices.get(cityId);
  if (stored?.hash === artifact.hash) {
    publish(cityId, stored.notices);
    return;
  }
  const response = await fetchImpl(artifact.url, { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (await sha256Hex(bytes) !== artifact.hash) throw new Error("notices hash mismatch");
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isServiceNoticesBody(body)) throw new Error("unsupported notices body");
  await db.serviceNotices.put({ cityId, hash: artifact.hash, sizeBytes: bytes.byteLength, storedAt: Date.now(), notices: body.notices });
  publish(cityId, body.notices);
}

/** Load stored notices (offline start, city switch) into the store. */
export async function loadServiceNotices(cityId: string): Promise<ServiceNotice[]> {
  let notices = EMPTY;
  try {
    notices = (await db.serviceNotices.get(cityId))?.notices ?? EMPTY;
  } catch (error) {
    console.warn(`[serviceNotices] ${cityId}: stored notices unreadable`, error);
  }
  // A sync that finished meanwhile is newer than this read.
  if (cityId in useServiceNoticesStore.getState().byCity) return useServiceNoticesStore.getState().byCity[cityId]!;
  publish(cityId, notices);
  return notices;
}

export async function clearServiceNotices(cityId?: string): Promise<void> {
  if (cityId) {
    await db.serviceNotices.delete(cityId);
    useServiceNoticesStore.setState(state => {
      const { [cityId]: _removed, ...rest } = state.byCity;
      return { byCity: rest };
    });
  } else {
    await db.serviceNotices.clear();
    useServiceNoticesStore.setState({ byCity: {} });
  }
}
