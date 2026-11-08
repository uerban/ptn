/**
 * Per-city realtime availability, as announced by the server.
 *
 * Every manifest response carries `X-PT-Realtime` listing the GTFS-RT kinds
 * the server has configured for that city (`departures`, `alerts`). The value
 * describes configuration, not feed health. It is stored per city in
 * localStorage so an offline launch still knows what the city offers: the
 * manifest itself is only kept in memory.
 *
 * The stored value is public, non-personal metadata. Reading it never makes a
 * request, so deciding whether to show a realtime surface or offer is free.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
  parseRealtimeHeader,
  REALTIME_KINDS,
  type RealtimeKind,
} from "@pt/shared/schedule-tile";
import { onStorageKeyChange } from "./crossTab.ts";

export const REALTIME_AVAILABILITY_STORAGE_KEY = "ptn-realtime-availability";

const CITY_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Bound on stored cities, so a corrupted or hostile value cannot grow. */
const MAX_CITIES = 64;

interface StoredCityAvailability {
  kinds: RealtimeKind[];
  /** Epoch milliseconds of the manifest response that carried the value. */
  seenAt: number;
}

type StoredAvailability = Record<string, StoredCityAvailability>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function sanitize(raw: unknown): StoredAvailability {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: StoredAvailability = {};
  let count = 0;
  for (const [city, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_CITIES) break;
    if (!CITY_ID_PATTERN.test(city)) continue;
    if (!value || typeof value !== "object") continue;
    const { kinds, seenAt } = value as Record<string, unknown>;
    if (!Array.isArray(kinds)) continue;
    const valid = REALTIME_KINDS.filter((kind) => kinds.includes(kind));
    result[city] = {
      kinds: valid,
      seenAt: typeof seenAt === "number" && Number.isFinite(seenAt) ? seenAt : 0,
    };
    count += 1;
  }
  return result;
}

function read(storage: StorageLike | undefined): StoredAvailability {
  if (!storage) return {};
  try {
    const raw = storage.getItem(REALTIME_AVAILABILITY_STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One failing listener must not stop the others.
    }
  }
}

/**
 * Record the `X-PT-Realtime` value of a manifest response for `cityId`. The
 * server always sends the header, empty when the city offers no realtime
 * kinds. A missing header (an older server, or a proxy that strips it) says
 * nothing and leaves what is stored as it was. Writes only when the value
 * changed.
 */
export function recordRealtimeHeader(
  cityId: string,
  headerValue: string | null | undefined,
  options: { storage?: StorageLike; now?: number } = {},
): void {
  if (!CITY_ID_PATTERN.test(cityId)) return;
  if (headerValue === null || headerValue === undefined) return;
  const storage = options.storage ?? defaultStorage();
  if (!storage) return;
  const kinds = parseRealtimeHeader(headerValue);
  const stored = read(storage);
  const previous = stored[cityId];
  const unchanged =
    previous !== undefined &&
    previous.kinds.length === kinds.length &&
    previous.kinds.every((kind, i) => kind === kinds[i]);
  if (unchanged) return;
  stored[cityId] = { kinds, seenAt: options.now ?? Date.now() };
  try {
    storage.setItem(REALTIME_AVAILABILITY_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Quota or disabled storage: availability falls back to "unknown".
    return;
  }
  notify();
}

/**
 * Realtime kinds the server announced for `cityId`, or `undefined` when no
 * manifest response has been seen for it yet (copy then says "where
 * available" without naming the city's features).
 */
export function getRealtimeAvailability(
  cityId: string,
  storage: StorageLike | undefined = defaultStorage(),
): readonly RealtimeKind[] | undefined {
  return read(storage)[cityId]?.kinds;
}

/** True only when the stored value for `cityId` lists `kind`. */
export function isRealtimeKindAvailable(
  cityId: string,
  kind: RealtimeKind,
  storage?: StorageLike,
): boolean {
  return getRealtimeAvailability(cityId, storage)?.includes(kind) ?? false;
}

/**
 * Call `listener` whenever stored availability changes, in this tab or in
 * another one. Returns an unsubscriber.
 */
export function subscribeRealtimeAvailability(listener: () => void): () => void {
  listeners.add(listener);
  const stopCrossTab = onStorageKeyChange(
    REALTIME_AVAILABILITY_STORAGE_KEY,
    listener,
  );
  return () => {
    listeners.delete(listener);
    stopCrossTab();
  };
}

export type RealtimeKindStatus = "available" | "unavailable" | "unknown";

/** Whether the city offers `kind`, or `unknown` before any manifest was seen. */
export function realtimeKindStatus(
  cityId: string,
  kind: RealtimeKind,
  storage?: StorageLike,
): RealtimeKindStatus {
  const kinds = getRealtimeAvailability(cityId, storage);
  if (kinds === undefined) return "unknown";
  return kinds.includes(kind) ? "available" : "unavailable";
}

/** React binding of `realtimeKindStatus`; follows changes from any tab. */
export function useRealtimeKindStatus(
  cityId: string,
  kind: RealtimeKind,
): RealtimeKindStatus {
  const get = useCallback(() => realtimeKindStatus(cityId, kind), [cityId, kind]);
  return useSyncExternalStore(subscribeRealtimeAvailability, get, get);
}
