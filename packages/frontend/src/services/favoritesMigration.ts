import type { BaseEndpoint, FavoritePlace } from "@pt/shared";
import { db, type SavedLocationRecord } from "../db/index.ts";
import { encrypt, type EncryptedRecord } from "./cryptoBox.ts";
import { getOrCreateInstallKey } from "./installKey.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";

export const LEGACY_FAVORITES_KEY = "ptn-favorites";

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

function readLegacyFavorites(): FavoritePlace[] | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(LEGACY_FAVORITES_KEY);
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

function isSensitiveType(type: FavoritePlace["type"]): boolean {
  return type === "home" || type === "work";
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

async function buildRecord(
  fav: FavoritePlace,
): Promise<SavedLocationRecord> {
  const endpoint = mapToEndpoint(fav);
  const encrypted = isSensitiveType(fav.type);
  let stored: BaseEndpoint | EncryptedRecord = endpoint;
  if (encrypted) {
    const key = await getOrCreateInstallKey();
    stored = await encrypt(endpoint, key);
  }
  return {
    id: fav.id,
    endpoint: stored,
    alias: fav.name,
    savedAt: parseSavedAt(fav.createdAt),
    encrypted,
  };
}

/**
 * One-shot migration from `localStorage["ptn-favorites"]` into Dexie's
 * `savedLocations`. Gated behind `settingsStore.enableFavoritesMigration`
 * unless `opts.force` is set. Safe to re-run: a successful migration clears
 * the legacy key, so the second call is a no-op; on failure the legacy key is
 * left intact and already-written rows will be overwritten idempotently
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

  const favorites = readLegacyFavorites();
  if (!favorites || favorites.length === 0) {
    return { migrated: 0, legacyCleared: false, skipped: false };
  }

  const records: SavedLocationRecord[] = [];
  for (const fav of favorites) {
    records.push(await buildRecord(fav));
  }

  for (const rec of records) {
    await db.savedLocations.put(rec);
  }

  localStorage.removeItem(LEGACY_FAVORITES_KEY);

  return {
    migrated: records.length,
    legacyCleared: true,
    skipped: false,
  };
}
