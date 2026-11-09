import type { BaseEndpoint, FavoritePlace } from "@pt/shared";
import { listSaves, restoreSaves, type SavePayload } from "./saves.ts";
import { canonicalCityId } from "../utils/cityId.ts";
import { readSealedItem, removeSealedItem } from "./sealedLocalStorage.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { LEGACY_FAVORITES_KEY } from "./privacyStorageKeys.ts";

export { LEGACY_FAVORITES_KEY };

/**
 * Zustand-persist envelope for the legacy favoritesStore. Shape:
 * `{ state: { favorites: FavoritePlace[] }, version: number }`.
 */
interface LegacyFavoritesEnvelope {
  state?: { favorites?: FavoritePlace[] };
  version?: number;
}

export interface MigrationResult {
  /** Number of favorites successfully mapped and written. */
  migrated: number;
  /** Whether the legacy localStorage key was removed at the end. */
  legacyCleared: boolean;
  /** Whether the migration was skipped because the flag was off. */
  skipped: boolean;
}

export interface MigrationOptions {
  /** Bypass the `enableFavoritesMigration` flag in tests. */
  force?: boolean;
}

async function readLegacyFavorites(): Promise<FavoritePlace[] | null> {
  const raw = await readSealedItem(LEGACY_FAVORITES_KEY);
  if (!raw) return null;
  let parsed: LegacyFavoritesEnvelope;
  try {
    parsed = JSON.parse(raw) as LegacyFavoritesEnvelope;
  } catch {
    return null;
  }
  const list = parsed?.state?.favorites;
  return Array.isArray(list) ? list : null;
}

function readRawItem(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function mapToEndpoint(fav: FavoritePlace): BaseEndpoint {
  if (fav.stopId) {
    return {
      kind: "stop",
      stopId: fav.stopId,
      name: fav.name,
      lat: fav.location.lat,
      lon: fav.location.lon,
    };
  }
  return {
    kind: "geocoded",
    lat: fav.location.lat,
    lon: fav.location.lon,
    label: fav.name,
    provider: "legacy-favorite",
    confidence: 1,
  };
}

function parseSavedAt(createdAt: string): number {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? t : Date.now();
}

function buildPayload(fav: FavoritePlace): SavePayload {
  return {
    origin: mapToEndpoint(fav),
    ...(fav.cityId ? { cityId: canonicalCityId(fav.cityId) } : {}),
    alias: fav.name,
    savedAt: parseSavedAt(fav.createdAt),
    placeType: fav.type,
  };
}

/**
 * One-shot migration from `localStorage["ptn-favorites"]` into Dexie's
 * `savedLocations`. Gated behind `settingsStore.enableFavoritesMigration`
 * unless `opts.force` is set. Safe to re-run: a successful migration clears
 * the legacy key, so the second call is a no-op; on failure the legacy key is
 * left intact. Writes commit atomically and retries preserve existing records
 * (ids are preserved from `FavoritePlace.id`).
 */
export async function migrateFavoritesToSaves(
  opts: MigrationOptions = {},
): Promise<MigrationResult> {
  const flagOn =
    opts.force === true ||
    useSettingsStore.getState().enableFavoritesMigration;
  if (!flagOn) {
    return { migrated: 0, legacyCleared: false, skipped: true };
  }

  const legacySnapshot = readRawItem(LEGACY_FAVORITES_KEY);
  const favorites = await readLegacyFavorites();
  if (!favorites || favorites.length === 0) {
    return { migrated: 0, legacyCleared: false, skipped: false };
  }

  // A retry must not overwrite a newer save or a user's city assignment.
  const existing = new Set((await listSaves()).map((save) => save.id));
  const pending = favorites
    .filter((fav) => !existing.has(fav.id))
    .map((fav) => ({ id: fav.id, payload: buildPayload(fav) }));
  const durable = (await restoreSaves(pending)) === "stored";
  const migrated = pending.length;

  // Favorites kept only for this session stay in their sealed source too, and
  // a source rewritten while this ran is kept for the next attempt.
  const legacyCleared = durable && readRawItem(LEGACY_FAVORITES_KEY) === legacySnapshot;
  if (legacyCleared) removeSealedItem(LEGACY_FAVORITES_KEY);

  return {
    migrated,
    legacyCleared,
    skipped: false,
  };
}
