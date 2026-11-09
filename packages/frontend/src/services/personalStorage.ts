/**
 * Encrypted persistence for personal records: recents, saved places and
 * journeys, and stop-use history.
 *
 * Every persisted record is one row of an opaque random id plus ciphertext of
 * the whole payload (endpoints, labels, timestamps, counts, stop IDs). There is
 * no plaintext write path. Ordering, deduplication and retention therefore run
 * in memory after decrypting.
 *
 * When durable encrypted storage is not possible (the install key cannot be
 * stored or read, or the storage migration has not completed) records are kept
 * in memory for this session only, nothing is written, and the status below
 * lets the UI say that saves will not be kept.
 */
import Dexie from "dexie";
import { create } from "zustand";
import { db, type SealedPersonalRow } from "../db/index.ts";
import { decrypt, encrypt, type EncryptedRecord } from "./cryptoBox.ts";
import { getOrCreateInstallKey, isInstallKeyDurable } from "./installKey.ts";
import { safeLocalStorage } from "./tolerantLocalStorage.ts";
import {
  getDegradedMode,
  subscribeDegradedMode,
  type DegradedMode,
} from "./installKeyDegrade.ts";

export type PersonalTable = "recentLocations" | "savedLocations" | "personalUsage";

export const PERSONAL_TABLES: readonly PersonalTable[] = [
  "recentLocations",
  "savedLocations",
  "personalUsage",
];

// ── Migration marker and status ─────────────────────────────────────────────

/** localStorage marker: personal data on this device is fully encrypted. */
export const PERSONAL_STORAGE_MARKER_KEY = "ptn-personal-storage";
export const PERSONAL_STORAGE_VERSION = "1";

export type PersonalStorageFailure =
  /** The install key could not be read or stored. */
  | "key-unavailable"
  /** The browser refused to store more data. */
  | "storage-full"
  /** Any other error while converting existing data. */
  | "failed";

export interface PersonalStorageStatus {
  /** `failed`: existing data is not yet secured; personal writes stopped. */
  migration: "pending" | "running" | "complete" | "failed";
  failure: PersonalStorageFailure | null;
  keyMode: DegradedMode | null;
  /** Records present on this device that could not be decrypted. */
  unreadable: number;
}

export const usePersonalStorageStatus = create<PersonalStorageStatus>(() => ({
  migration: "pending",
  failure: null,
  keyMode: getDegradedMode(),
  unreadable: 0,
}));

subscribeDegradedMode((keyMode) => {
  usePersonalStorageStatus.setState({ keyMode });
});

export function isPersonalStorageMigrated(
  storage?: Pick<Storage, "getItem">,
): boolean {
  try {
    const active = storage ?? globalThis.localStorage;
    return active?.getItem(PERSONAL_STORAGE_MARKER_KEY) === PERSONAL_STORAGE_VERSION;
  } catch {
    return false;
  }
}

/** True when personal records are only kept for this session. */
export function isPersonalStorageSessionOnly(
  status: PersonalStorageStatus = usePersonalStorageStatus.getState(),
): boolean {
  return status.keyMode !== null || status.migration === "failed";
}

let migrationRun: Promise<unknown> | null = null;

// The migration module imports stores that hydrate through this module, so it
// cannot be imported statically. It registers itself once fully evaluated.
let migrationStarter: (() => Promise<unknown>) | null = null;
let resolveStarter: () => void = () => {};
const starterReady = new Promise<void>((resolve) => {
  resolveStarter = resolve;
});

export function registerPersonalStorageMigration(start: () => Promise<unknown>): void {
  migrationStarter = start;
  resolveStarter();
}

async function startMigration(): Promise<void> {
  if (!migrationStarter) {
    void import("./personalStorageMigration.ts").catch(() => {});
    await starterReady;
  }
  await migrationStarter?.();
}

/** Records the outcome of the storage migration for readers and the UI. */
export function setPersonalStorageMigrationState(
  migration: PersonalStorageStatus["migration"],
  failure: PersonalStorageFailure | null = null,
): void {
  usePersonalStorageStatus.setState({ migration, failure });
}

/**
 * Registers an in-flight storage migration. Personal reads and writes wait for
 * it, which freezes writers in this tab while existing data is converted.
 */
export function trackPersonalStorageMigration<T>(run: Promise<T>): Promise<T> {
  migrationRun = run;
  const clear = () => {
    if (migrationRun === run) migrationRun = null;
  };
  run.then(clear, clear);
  return run;
}

/**
 * Resolves once no storage migration is running in this tab. A reader that
 * arrives before the device was converted (stores hydrate at import time)
 * starts the migration rather than treating unconverted data as absent. After
 * a failed attempt it does not retry on its own; the rider retries.
 */
export async function whenPersonalStorageSettled(): Promise<void> {
  if (
    !migrationRun &&
    usePersonalStorageStatus.getState().migration !== "failed" &&
    !isPersonalStorageMigrated()
  ) {
    await startMigration();
  }
  while (migrationRun) {
    await migrationRun.catch(() => {});
  }
}

/**
 * The key for durable encrypted personal storage, or null when records must be
 * kept for this session only.
 */
export async function durablePersonalKey(): Promise<CryptoKey | null> {
  await whenPersonalStorageSettled();
  if (!isPersonalStorageMigrated()) return null;
  try {
    const key = await getOrCreateInstallKey();
    return isInstallKeyDurable() ? key : null;
  } catch {
    return null;
  }
}

// ── Session-only records ────────────────────────────────────────────────────

const session = new Map<PersonalTable, Map<string, unknown>>();
const sessionListeners = new Set<() => void>();

function sessionTable(table: PersonalTable): Map<string, unknown> {
  let entries = session.get(table);
  if (!entries) {
    entries = new Map();
    session.set(table, entries);
  }
  return entries;
}

function notifySession(): void {
  for (const fn of sessionListeners) {
    try {
      fn();
    } catch {
      // A failing subscriber must not block the others.
    }
  }
}

/** Called when session-only records change (they are invisible to Dexie). */
export function subscribePersonalSession(fn: () => void): () => void {
  sessionListeners.add(fn);
  return () => {
    sessionListeners.delete(fn);
  };
}

// ── Rows ────────────────────────────────────────────────────────────────────

export function newPersonalId(): string {
  return crypto.randomUUID();
}

export function isSealedRow(row: unknown): row is SealedPersonalRow {
  if (!row || typeof row !== "object") return false;
  const sealed = (row as { sealed?: unknown }).sealed;
  return (
    typeof (row as { id?: unknown }).id === "string" &&
    !!sealed &&
    typeof sealed === "object" &&
    "iv" in sealed &&
    "ct" in sealed &&
    "v" in sealed
  );
}

export async function sealRow<T>(
  id: string,
  value: T,
  key: CryptoKey,
): Promise<SealedPersonalRow> {
  return { id, sealed: await encrypt(value, key) };
}

export async function openRow<T>(
  row: SealedPersonalRow,
  key: CryptoKey,
): Promise<T> {
  return (await decrypt(row.sealed as EncryptedRecord, key)) as T;
}

export interface PersonalEntry<T> {
  id: string;
  value: T;
  /** False for records kept in memory for this session only. */
  durable: boolean;
}

const durableCache = new Map<PersonalTable, Promise<PersonalEntry<unknown>[]>>();
const unreadableBySource = new Map<string, number>();

function invalidateDurableCache(): void {
  durableCache.clear();
}

// Writes from other tabs (and Dexie live queries) arrive through this event.
Dexie.on("storagemutated", invalidateDurableCache);

/** Records how many records of one table or storage key failed to decrypt. */
export function reportUnreadable(source: string, count: number): void {
  unreadableBySource.set(source, count);
  let total = 0;
  for (const n of unreadableBySource.values()) total += n;
  if (usePersonalStorageStatus.getState().unreadable !== total) {
    usePersonalStorageStatus.setState({ unreadable: total });
  }
}

/**
 * A legacy record the storage migration could not decrypt. It is kept sealed
 * whole (never as plaintext) until the rider deletes it.
 */
export function isUnreadableLegacy(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { unreadableLegacy?: unknown }).unreadableLegacy === true
  );
}

/** Decrypts sealed rows. Rows that do not decrypt are counted, not returned. */
export async function openRows<T>(
  table: PersonalTable,
  rows: readonly unknown[],
  key: CryptoKey,
): Promise<PersonalEntry<T>[]> {
  const out: PersonalEntry<T>[] = [];
  let unreadable = 0;
  for (const row of rows) {
    // Rows from before encryption was complete are the migration's business.
    if (!isSealedRow(row)) continue;
    try {
      const value = await openRow<T>(row, key);
      if (isUnreadableLegacy(value)) unreadable += 1;
      else out.push({ id: row.id, value, durable: true });
    } catch {
      unreadable += 1;
    }
  }
  reportUnreadable(table, unreadable);
  return out;
}

/**
 * Deletes the stored records of a table that cannot be read with the current
 * key. Readable records are kept. Returns how many were deleted.
 */
export async function deleteUnreadablePersonal(table: PersonalTable): Promise<number> {
  const key = await durablePersonalKey();
  if (!key) return 0;
  const doomed: string[] = [];
  for (const row of await db.table(table).toArray()) {
    if (!isSealedRow(row)) continue;
    try {
      if (isUnreadableLegacy(await openRow<unknown>(row, key))) doomed.push(row.id);
    } catch {
      doomed.push(row.id);
    }
  }
  invalidateDurableCache();
  await db.table(table).bulkDelete(doomed);
  invalidateDurableCache();
  reportUnreadable(table, 0);
  return doomed.length;
}

async function loadDurable<T>(table: PersonalTable): Promise<PersonalEntry<T>[]> {
  const key = await durablePersonalKey();
  if (!key) return [];
  let cached = durableCache.get(table);
  if (!cached) {
    cached = db
      .table(table)
      .toArray()
      .then((rows) => openRows<unknown>(table, rows, key));
    durableCache.set(table, cached);
    cached.catch(() => {
      if (durableCache.get(table) === cached) durableCache.delete(table);
    });
  }
  return (await cached) as PersonalEntry<T>[];
}

function sessionEntries<T>(table: PersonalTable): PersonalEntry<T>[] {
  return [...sessionTable(table).entries()].map(([id, value]) => ({
    id,
    value: value as T,
    durable: false,
  }));
}

/** Every readable record of a table: durable ones and this session's. */
export async function listPersonal<T>(
  table: PersonalTable,
): Promise<PersonalEntry<T>[]> {
  const durable = await loadDurable<T>(table);
  const sessionOnly = sessionEntries<T>(table);
  if (sessionOnly.length === 0) return durable;
  const sessionIds = new Set(sessionOnly.map((e) => e.id));
  return [...durable.filter((e) => !sessionIds.has(e.id)), ...sessionOnly];
}

/** Decrypts rows a caller already read (e.g. through a Dexie live query). */
export async function resolvePersonalRows<T>(
  table: PersonalTable,
  rows: readonly unknown[],
): Promise<PersonalEntry<T>[]> {
  const key = await durablePersonalKey();
  const durable = key ? await openRows<T>(table, rows, key) : [];
  const sessionOnly = sessionEntries<T>(table);
  const sessionIds = new Set(sessionOnly.map((e) => e.id));
  return [...durable.filter((e) => !sessionIds.has(e.id)), ...sessionOnly];
}

export interface PutPersonalOptions {
  /** Keep this record in memory only, whatever storage allows. */
  sessionOnly?: boolean;
  /**
   * Checked right before the record is written, after the key was acquired
   * and the record sealed. Returning false drops the write (for example,
   * consent was withdrawn meanwhile).
   */
  commitIf?: () => boolean;
}

/** `discarded`: the table was cleared, or `commitIf` refused, while the
 * record was being prepared; nothing was written. */
export type PersonalWriteResult = "stored" | "session" | "discarded";

/** Bumped by every clear of a table in this tab. */
const clearGenerations = new Map<PersonalTable, number>();

/**
 * localStorage key of a table's clear mark: a fresh random value replaced by
 * every clear of that table in any tab. A tab's own counter cannot see a clear
 * made in another tab, so a write prepared there before the clear also checks
 * this mark. One key per table, so clears of different tables never overwrite
 * each other's marks. Holds no personal data.
 */
export function personalClearMarkKey(table: PersonalTable): string {
  return `ptn-personal-clear:${table}`;
}

function storedClearMark(table: PersonalTable): string {
  try {
    return safeLocalStorage()?.getItem(personalClearMarkKey(table)) ?? "";
  } catch {
    return "";
  }
}

function markCleared(table: PersonalTable): void {
  try {
    safeLocalStorage()?.setItem(personalClearMarkKey(table), newPersonalId());
  } catch {
    // Not stored: other tabs only learn of this clear through their reads.
  }
}

/** Changes whenever the table is cleared, in this tab or in another one. */
function clearGeneration(table: PersonalTable): string {
  return `${clearGenerations.get(table) ?? 0}:${storedClearMark(table)}`;
}

/**
 * Identifies the table's latest clear, in this tab or another. A caller that
 * reads before writing captures it first and passes `commitIf`, so a clear
 * during the read also drops the write.
 */
export function personalClearGeneration(table: PersonalTable): string {
  return clearGeneration(table);
}

/**
 * Writes one record. It is sealed and stored when durable encrypted storage is
 * available; otherwise it is kept for this session only. A clear of the table
 * while the record is being prepared discards it, so a deletion is never
 * undone by a write that was already in flight.
 */
export async function putPersonal<T>(
  table: PersonalTable,
  id: string,
  value: T,
  opts: PutPersonalOptions = {},
): Promise<PersonalWriteResult> {
  const generation = clearGeneration(table);
  const mayCommit = () =>
    clearGeneration(table) === generation && (opts.commitIf?.() ?? true);
  const key = opts.sessionOnly ? null : await durablePersonalKey();
  if (!key) {
    if (!mayCommit()) return "discarded";
    sessionTable(table).set(id, value);
    notifySession();
    return "session";
  }
  const row = await sealRow(id, value, key);
  if (!mayCommit()) return "discarded";
  invalidateDurableCache();
  await db.table(table).put(row);
  invalidateDurableCache();
  if (sessionTable(table).delete(id)) notifySession();
  return "stored";
}

/**
 * Writes several records together: every record is sealed first, then all are
 * stored in one transaction, so a failure stores none of them.
 */
export async function putPersonalMany<T>(
  table: PersonalTable,
  entries: readonly { id: string; value: T }[],
): Promise<PersonalWriteResult> {
  if (entries.length === 0) return "stored";
  const key = await durablePersonalKey();
  if (!key) {
    for (const { id, value } of entries) sessionTable(table).set(id, value);
    notifySession();
    return "session";
  }
  const rows = await Promise.all(entries.map(({ id, value }) => sealRow(id, value, key)));
  invalidateDurableCache();
  await db.transaction("rw", db.table(table), async () => {
    await db.table(table).bulkPut(rows);
  });
  invalidateDurableCache();
  let changed = false;
  for (const { id } of entries) changed = sessionTable(table).delete(id) || changed;
  if (changed) notifySession();
  return "stored";
}

export async function deletePersonal(
  table: PersonalTable,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const entries = sessionTable(table);
  let changed = false;
  for (const id of ids) changed = entries.delete(id) || changed;
  if (changed) notifySession();
  invalidateDurableCache();
  await db.table(table).bulkDelete([...ids]);
  invalidateDurableCache();
}

/** Removes every record of a table, durable, legacy and session-only. */
export async function clearPersonal(table: PersonalTable): Promise<void> {
  clearGenerations.set(table, (clearGenerations.get(table) ?? 0) + 1);
  markCleared(table);
  if (sessionTable(table).size > 0) {
    sessionTable(table).clear();
    notifySession();
  }
  invalidateDurableCache();
  await db.table(table).clear();
  invalidateDurableCache();
  reportUnreadable(table, 0);
}

/** Drops this session's in-memory records of a table. */
export function clearSessionPersonal(table: PersonalTable): void {
  if (sessionTable(table).size === 0) return;
  sessionTable(table).clear();
  notifySession();
}

/** Moves records between durable storage and this session's memory. */
export async function moveDurableToSession(table: PersonalTable): Promise<void> {
  const durable = await loadDurable<unknown>(table);
  const entries = sessionTable(table);
  for (const entry of durable) entries.set(entry.id, entry.value);
  invalidateDurableCache();
  // Only what was read moves; unreadable rows stay until the rider deletes
  // them rather than being destroyed by a level change.
  await db.table(table).bulkDelete(durable.map((e) => e.id));
  invalidateDurableCache();
  if (durable.length > 0) notifySession();
}

export async function moveSessionToDurable(table: PersonalTable): Promise<void> {
  const entries = sessionTable(table);
  if (entries.size === 0) return;
  for (const [id, value] of [...entries.entries()]) {
    await putPersonal(table, id, value);
  }
}

/** Test-only: drops session records, caches and status. */
export function __resetPersonalStorageForTests(): void {
  session.clear();
  sessionListeners.clear();
  clearGenerations.clear();
  durableCache.clear();
  unreadableBySource.clear();
  migrationRun = null;
  usePersonalStorageStatus.setState({
    migration: "pending",
    failure: null,
    keyMode: getDegradedMode(),
    unreadable: 0,
  });
}
