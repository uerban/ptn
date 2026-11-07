import type { BaseEndpoint, RecentRef } from "@pt/shared";
import { LEVEL_FLOORS, type PrivacyLevel, type PrivacyPolicy } from "@pt/shared/privacy";
import {
  clearPersonal,
  clearSessionPersonal,
  deletePersonal,
  listPersonal,
  moveDurableToSession,
  moveSessionToDurable,
  newPersonalId,
  putPersonal,
  type PersonalEntry,
} from "./personalStorage.ts";
import { getPolicy, registerLevelChangeListener } from "../stores/privacyStore.ts";
import { isOptionalStorageEnabledNow } from "./privacyChoices.ts";

export const MAX_RECENTS = 50;

export const RECENTS_LIST_LIMIT = 25;

export const RECENTS_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const TABLE = "recentLocations";

/** Everything about a recent, sealed whole when persisted. */
export interface RecentPayload {
  endpoint: BaseEndpoint;
  usedAt: number;
  usedAsOrigin: boolean;
}

// Decrypted snapshot cache (hot-path: listRecents runs per keystroke). Invalidated
// by every mutation (recordRecent / clearRecents / migrateRecentsForLevelChange).
let _recentsCache: RecentRef[] | null = null;
function invalidateRecentsCache(): void {
  _recentsCache = null;
}

/** `encrypted`: sealed in IndexedDB. `ram-only`: this session only. */
export type RecentsTier = "encrypted" | "ram-only";

/** Collapse the `recentsEncryption` axis onto the storage tiers. */
export function tierForRecentsAxis(
  axis: PrivacyPolicy["recentsEncryption"],
): RecentsTier {
  // "off" never reaches storage (recordRecent/listRecents short-circuit first);
  // collapse defensively to ram-only so a stray call cannot persist a row.
  if (axis === "ram-only" || axis === "off") return "ram-only";
  return "encrypted";
}

/**
 * Maximum age before a persisted recent is swept, or `null` if the axis
 * imposes no TTL. Hardened → 30d, Strict → 7d; other axes retain indefinitely
 * (the LRU cap still bounds growth).
 */
export function ttlForRecentsAxis(
  axis: PrivacyPolicy["recentsEncryption"],
): number | null {
  if (axis === "encrypted-30d") return 30 * DAY_MS;
  if (axis === "encrypted-7d") return 7 * DAY_MS;
  return null;
}

export interface RecordRecentOptions {
  usedAsOrigin: boolean;
  /** Test hook: override clock. */
  now?: () => number;
  /** Test hook: override the resolved tier (bypasses policy lookup). */
  tier?: RecentsTier;
}

/**
 * Identity of a `BaseEndpoint`. Identical endpoints collapse onto the same
 * recent, so re-visiting a location updates `usedAt` in place rather than
 * producing duplicates. Computed in memory only: stored rows carry an opaque
 * random id, never this value.
 */
export function endpointFingerprint(ep: BaseEndpoint): string {
  switch (ep.kind) {
    case "stop":
      return `stop:${ep.stopId}`;
    case "geocoded":
      return `geo:${ep.lat.toFixed(5)}:${ep.lon.toFixed(5)}:${ep.label}`;
    case "mappoint":
      return `map:${ep.lat.toFixed(5)}:${ep.lon.toFixed(5)}`;
    case "stopGroup":
      // Member-set identity: same siblings collapse onto one recents row
      // regardless of which sibling/centroid produced the tap.
      return `group:${[...ep.stopIds].sort().join(",")}`;
    default: {
      // Exhaustiveness gate: a new BaseEndpoint kind with no case above fails
      // tsc here (not assignable to `never`), independent of the `: string`
      // return annotation. Matches the repo's `_exhaustive` idiom.
      const _exhaustive: never = ep;
      return _exhaustive;
    }
  }
}

function isRecentPayload(value: unknown): value is RecentPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<RecentPayload>;
  return (
    !!v.endpoint &&
    typeof v.endpoint === "object" &&
    typeof v.usedAt === "number" &&
    typeof v.usedAsOrigin === "boolean"
  );
}

async function listRecentEntries(): Promise<PersonalEntry<RecentPayload>[]> {
  const entries = await listPersonal<unknown>(TABLE);
  return entries.filter((e): e is PersonalEntry<RecentPayload> =>
    isRecentPayload(e.value),
  );
}

export async function recordRecent(
  endpoint: BaseEndpoint,
  opts: RecordRecentOptions,
): Promise<void> {
  if (!isOptionalStorageEnabledNow("recents")) return;
  const axis = getPolicy().recentsEncryption;
  if (opts.tier === undefined && axis === "off") return; // Off: never record
  const tier = opts.tier ?? tierForRecentsAxis(axis);
  const now = opts.now ? opts.now() : Date.now();
  const fingerprint = endpointFingerprint(endpoint);

  const entries = await listRecentEntries();
  const existing = entries.find(
    (e) => endpointFingerprint(e.value.endpoint) === fingerprint,
  );
  const id = existing?.id ?? newPersonalId();
  const payload: RecentPayload = {
    endpoint,
    usedAt: now,
    usedAsOrigin: opts.usedAsOrigin,
  };
  invalidateRecentsCache();
  await putPersonal(TABLE, id, payload, {
    sessionOnly: tier === "ram-only",
  });

  const after = existing
    ? entries.map((e) => (e.id === id ? { ...e, value: payload } : e))
    : [...entries, { id, value: payload, durable: false }];
  if (after.length > MAX_RECENTS) {
    const oldest = [...after]
      .sort((a, b) => a.value.usedAt - b.value.usedAt)
      .slice(0, after.length - MAX_RECENTS)
      .map((e) => e.id);
    await deletePersonal(TABLE, oldest);
  }
  invalidateRecentsCache();
}

/**
 * Returns all recents as `RecentRef[]`, newest-first. Capped at
 * `RECENTS_LIST_LIMIT` entries. Results are cached in module scope
 * (invalidated on every write) so this is safe to call per debounced keystroke.
 * Returns `[]` immediately when the `recentsEncryption` axis is `"off"`.
 */
export async function listRecents(): Promise<RecentRef[]> {
  if (!isOptionalStorageEnabledNow("recents")) return [];
  const axis = getPolicy().recentsEncryption;
  if (axis === "off") return [];
  if (_recentsCache) return _recentsCache;
  const out: RecentRef[] = (await listRecentEntries()).map((e) => ({
    kind: "recent",
    base: e.value.endpoint,
    usedAt: e.value.usedAt,
    usedAsOrigin: e.value.usedAsOrigin,
  }));
  out.sort((a, b) => b.usedAt - a.usedAt);
  _recentsCache = out.slice(0, RECENTS_LIST_LIMIT);
  return _recentsCache;
}

/**
 * Count for the Off-switch confirm: every readable recent, persisted or kept
 * for this session. Returns 0 when the axis is `"off"`.
 */
export async function countRecents(): Promise<number> {
  const axis = getPolicy().recentsEncryption;
  if (axis === "off") return 0;
  return (await listRecentEntries()).length;
}

export interface SweepRecentsOptions {
  now?: () => number;
  /** Override the axis used to derive the TTL (defaults to current policy). */
  axis?: PrivacyPolicy["recentsEncryption"];
}

/**
 * Removes recents older than the TTL implied by the current
 * `recentsEncryption` axis. Timestamps are sealed, so this decrypts and then
 * filters. Returns the number of records deleted.
 */
export async function sweepRecents(
  opts: SweepRecentsOptions = {},
): Promise<number> {
  const axis = opts.axis ?? getPolicy().recentsEncryption;
  const ttl = ttlForRecentsAxis(axis);
  if (ttl === null) return 0;
  const now = opts.now ? opts.now() : Date.now();
  const cutoff = now - ttl;
  const staleIds = (await listRecentEntries())
    .filter((e) => e.value.usedAt < cutoff)
    .map((e) => e.id);
  if (staleIds.length === 0) return 0;
  await deletePersonal(TABLE, staleIds);
  invalidateRecentsCache();
  return staleIds.length;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Runs a sweep immediately, then schedules hourly sweeps. Returns a stopper.
 * Calling twice without stopping replaces the prior schedule.
 */
export function startRecentsSweep(opts: {
  intervalMs?: number;
} = {}): () => void {
  stopRecentsSweep();
  void sweepRecents().catch(() => {});
  const interval = opts.intervalMs ?? RECENTS_SWEEP_INTERVAL_MS;
  sweepTimer = setInterval(() => {
    void sweepRecents().catch(() => {});
  }, interval);
  return stopRecentsSweep;
}

export function stopRecentsSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * Drops every recent the user has — persisted rows (including any that could
 * not be decrypted) and this session's entries. Bound to the "purge recents"
 * Settings button. The caller is responsible for any user confirmation.
 */
export async function clearRecents(): Promise<void> {
  invalidateRecentsCache();
  await clearPersonal(TABLE);
  invalidateRecentsCache();
}

/**
 * Moves recents to the storage tier implied by `next` when a level change
 * crosses between persisted (sealed) and session-only (Paranoid). Neither
 * direction ever writes plaintext.
 */
export async function migrateRecentsForLevelChange(
  prev: PrivacyLevel,
  next: PrivacyLevel,
): Promise<void> {
  if (!isOptionalStorageEnabledNow("recents")) {
    await clearRecents();
    return;
  }
  const prevTier = tierForRecentsAxis(LEVEL_FLOORS[prev].recentsEncryption);
  const nextTier = tierForRecentsAxis(LEVEL_FLOORS[next].recentsEncryption);
  if (prevTier === nextTier) return;
  invalidateRecentsCache();
  if (nextTier === "ram-only") {
    await moveDurableToSession(TABLE);
  } else {
    await moveSessionToDurable(TABLE);
  }
  invalidateRecentsCache();
}

registerLevelChangeListener(migrateRecentsForLevelChange);

/** Test-only: drops this session's recents. */
export function __clearRamRecentsForTests(): void {
  clearSessionPersonal(TABLE);
  invalidateRecentsCache();
}

/** Test-only: resets the module-scope listRecents cache. */
export function __resetRecentsCacheForTests(): void {
  _recentsCache = null;
}

/** Test-only: this session's recents as a fingerprint→payload map. */
export async function __getRamRecentsForTests(): Promise<
  ReadonlyMap<string, RecentPayload>
> {
  const map = new Map<string, RecentPayload>();
  for (const e of await listRecentEntries()) {
    if (!e.durable) map.set(endpointFingerprint(e.value.endpoint), e.value);
  }
  return map;
}
