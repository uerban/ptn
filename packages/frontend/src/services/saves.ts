import type { BaseEndpoint, FavoritePlace, PrivacyPolicy } from "@pt/shared";
import {
  deletePersonal,
  listPersonal,
  newPersonalId,
  putPersonal,
  resolvePersonalRows,
  type PersonalEntry,
  type PersonalWriteResult,
} from "./personalStorage.ts";

const TABLE = "savedLocations";

/**
 * Everything about a save, sealed whole when persisted: endpoints, label,
 * time and colour. Pair saves carry `destination`; single-place saves
 * (map-tap saves, migrated favorites) do not.
 */
export interface SavePayload {
  origin: BaseEndpoint;
  destination?: BaseEndpoint;
  alias: string;
  savedAt: number;
  pinColor?: string;
  /** Kind of a save migrated from favorites (home, work, ...). */
  placeType?: FavoritePlace["type"];
}

export interface ResolvedSave {
  id: string;
  alias: string;
  origin: BaseEndpoint;
  destination?: BaseEndpoint;
  savedAt: number;
  pinColor?: string;
  placeType?: FavoritePlace["type"];
  /** False when the save is kept for this session only. */
  durable: boolean;
}

/**
 * Whether the "export save" action is available at the given policy axis.
 * Strict (`always-no-export`) and Paranoid (`always-no-share`) suppress
 * export; all lower axes allow it.
 */
export function canExportSaves(
  axis: PrivacyPolicy["savesEncryption"],
): boolean {
  return axis !== "always-no-export" && axis !== "always-no-share";
}

/**
 * Whether the "share save" action is available at the given policy axis.
 * Only Paranoid (`always-no-share`) suppresses sharing; every lower axis
 * (Baseline / Standard / Hardened / Strict) allows it.
 */
export function canShareSaves(
  axis: PrivacyPolicy["savesEncryption"],
): boolean {
  return axis !== "always-no-share";
}

export interface SaveRoutePairInput {
  origin: BaseEndpoint;
  destination: BaseEndpoint;
  /** Optional user-visible label; empty string is treated as absent. */
  alias?: string;
}

export interface SavePlaceInput {
  /** The single location being saved (already reduced through its own seam). */
  endpoint: BaseEndpoint;
  /** Optional user-visible label; empty string is treated as absent. */
  alias?: string;
  placeType?: FavoritePlace["type"];
}

export interface SaveOptions {
  /** Test hook: override the clock. */
  now?: () => number;
  /** Override the generated id (migrations keep a record's id). */
  id?: string;
}

export interface SaveResult {
  save: ResolvedSave;
  /** `session` when the save is kept only until the app closes. */
  stored: PersonalWriteResult;
}

/**
 * One-tap save of an (origin, destination, alias?) tuple from the route
 * results view. Sealed whole under the install key at every privacy level.
 */
export async function saveRoutePair(
  input: SaveRoutePairInput,
  opts: SaveOptions = {},
): Promise<SaveResult> {
  return writeSave(
    {
      origin: input.origin,
      destination: input.destination,
      alias: input.alias,
    },
    opts,
  );
}

/**
 * Save of a single location (no destination leg) — the map long-press
 * "Save with label" flow. Readers distinguish it from a pair save by the
 * absence of `destination`.
 *
 * The caller owns the precision seam: pass an endpoint already reduced by
 * `mapTapStore`, never a raw tap coord.
 */
export async function savePlace(
  input: SavePlaceInput,
  opts: SaveOptions = {},
): Promise<SaveResult> {
  return writeSave(
    { origin: input.endpoint, alias: input.alias, placeType: input.placeType },
    opts,
  );
}

async function writeSave(
  input: {
    origin: BaseEndpoint;
    destination?: BaseEndpoint;
    alias?: string;
    placeType?: FavoritePlace["type"];
  },
  opts: SaveOptions & { savedAt?: number },
): Promise<SaveResult> {
  const id = opts.id ?? newPersonalId();
  const payload: SavePayload = {
    origin: input.origin,
    ...(input.destination !== undefined ? { destination: input.destination } : {}),
    alias: (input.alias ?? "").trim(),
    savedAt: opts.savedAt ?? (opts.now ? opts.now() : Date.now()),
    ...(input.placeType !== undefined ? { placeType: input.placeType } : {}),
  };
  const stored = await putPersonal(TABLE, id, payload);
  return { save: toResolved({ id, value: payload, durable: stored === "stored" }), stored };
}

/** Writes a save that already has an id and time (used by migrations). */
export async function restoreSave(
  id: string,
  payload: SavePayload,
): Promise<PersonalWriteResult> {
  return putPersonal(TABLE, id, payload);
}

function isSavePayload(value: unknown): value is SavePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SavePayload>;
  return (
    !!v.origin &&
    typeof v.origin === "object" &&
    typeof v.alias === "string" &&
    typeof v.savedAt === "number"
  );
}

function toResolved(entry: PersonalEntry<SavePayload>): ResolvedSave {
  const v = entry.value;
  return {
    id: entry.id,
    alias: v.alias,
    origin: v.origin,
    ...(v.destination !== undefined ? { destination: v.destination } : {}),
    savedAt: v.savedAt,
    ...(v.pinColor !== undefined ? { pinColor: v.pinColor } : {}),
    ...(v.placeType !== undefined ? { placeType: v.placeType } : {}),
    durable: entry.durable,
  };
}

function resolveEntries(entries: PersonalEntry<unknown>[]): ResolvedSave[] {
  return entries
    .filter((e): e is PersonalEntry<SavePayload> => isSavePayload(e.value))
    .map(toResolved)
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Every readable save, newest first. */
export async function listSaves(): Promise<ResolvedSave[]> {
  return resolveEntries(await listPersonal<unknown>(TABLE));
}

/**
 * Decrypts rows read through a Dexie live query (plus this session's saves),
 * newest first.
 */
export async function resolveSavedRows(
  rows: readonly unknown[],
): Promise<ResolvedSave[]> {
  return resolveEntries(await resolvePersonalRows<unknown>(TABLE, rows));
}

export async function deleteSave(id: string): Promise<void> {
  await deletePersonal(TABLE, [id]);
}
