import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useFavoritesStore } from "../../stores/favoritesStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import type { BaseEndpoint, FavoritePlace } from "@pt/shared";
import { db, type SavedLocationRecord } from "../../db/index.ts";
import {
  decrypt,
  type EncryptedRecord,
} from "../../services/cryptoBox.ts";
import { getOrCreateInstallKey } from "../../services/installKey.ts";

interface FavoritesBarProps {
  onFavoriteClick: (favorite: FavoritePlace) => void;
}

const TYPE_ICONS: Record<FavoritePlace["type"], string> = {
  home: "\u{1F3E0}",
  work: "\u{1F3E2}",
  stop: "\u{1F68F}",
  place: "\u{1F4CD}",
};

export function FavoritesBar({ onFavoriteClick }: FavoritesBarProps) {
  const enableMigration = useSettingsStore(
    (s) => s.enableFavoritesMigration,
  );
  return enableMigration
    ? <SavedLocationsBar onFavoriteClick={onFavoriteClick} />
    : <LegacyFavoritesBar onFavoriteClick={onFavoriteClick} />;
}

function LegacyFavoritesBar({ onFavoriteClick }: FavoritesBarProps) {
  const favorites = useFavoritesStore((s) => s.favorites);
  const activeCityId = useCityStore((s) => s.activeCity.id);

  // Stop favorites are city-bound; non-stop favorites (home/work/place)
  // are coordinate-based shortcuts useful from any city.
  const cityFavorites = favorites.filter(
    (f) => f.type !== "stop" || f.cityId === activeCityId
  );

  if (cityFavorites.length === 0) return null;

  const sorted = [...cityFavorites].sort(
    (a, b) => a.sortOrder - b.sortOrder
  );

  return <FavoritesRow favorites={sorted} onFavoriteClick={onFavoriteClick} />;
}

function SavedLocationsBar({ onFavoriteClick }: FavoritesBarProps) {
  const rows = useLiveQuery(
    () => db.savedLocations.orderBy("savedAt").toArray(),
    [],
  );
  const [resolved, setResolved] = useState<FavoritePlace[] | null>(null);

  useEffect(() => {
    if (!rows) return;
    let cancelled = false;
    (async () => {
      const out = await resolveSavedLocations(rows);
      if (!cancelled) setResolved(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  if (!resolved || resolved.length === 0) return null;
  return <FavoritesRow favorites={resolved} onFavoriteClick={onFavoriteClick} />;
}

function FavoritesRow({
  favorites,
  onFavoriteClick,
}: {
  favorites: FavoritePlace[];
  onFavoriteClick: (favorite: FavoritePlace) => void;
}) {
  return (
    <div className="flex gap-2 px-3 py-2 overflow-x-auto scrollbar-hide">
      {favorites.map((fav) => (
        <button
          key={fav.id}
          onClick={() => onFavoriteClick(fav)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full
            bg-surface-raised shadow-1
            text-sm whitespace-nowrap
            hover:bg-surface-overlay transition-colors
            active:scale-95"
        >
          <span>{TYPE_ICONS[fav.type] ?? TYPE_ICONS.place}</span>
          <span className="text-fg-secondary">
            {fav.name}
          </span>
        </button>
      ))}
    </div>
  );
}

async function resolveSavedLocations(
  rows: SavedLocationRecord[],
): Promise<FavoritePlace[]> {
  const key = rows.some((r) => r.encrypted)
    ? await getOrCreateInstallKey().catch(() => null)
    : null;
  const out: FavoritePlace[] = [];
  for (const row of rows) {
    let endpoint: BaseEndpoint;
    if (row.encrypted) {
      if (!key) continue;
      try {
        endpoint = (await decrypt(
          row.endpoint as EncryptedRecord,
          key,
        )) as BaseEndpoint;
      } catch {
        continue;
      }
    } else {
      endpoint = row.endpoint as BaseEndpoint;
    }
    out.push(toFavoritePlace(row, endpoint));
  }
  return out;
}

function toFavoritePlace(
  row: SavedLocationRecord,
  endpoint: BaseEndpoint,
): FavoritePlace {
  const stopId = endpoint.kind === "stop" ? endpoint.stopId : undefined;
  const type: FavoritePlace["type"] = stopId
    ? "stop"
    : row.encrypted
      ? "home"
      : "place";
  return {
    id: row.id,
    name: row.alias,
    type,
    location: { lat: endpoint.lat, lon: endpoint.lon },
    stopId,
    sortOrder: -row.savedAt,
    createdAt: new Date(row.savedAt).toISOString(),
  };
}
