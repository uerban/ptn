import { useFavoritesStore } from "../../stores/favoritesStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import type { FavoritePlace } from "@pt/shared";
import { useResolvedSaves } from "../../hooks/useResolvedSaves.ts";
import { usePersistHydrated } from "../../hooks/usePersistHydrated.ts";
import { saveBelongsToCity, type ResolvedSave } from "../../services/saves.ts";
import { canonicalCityId } from "../../utils/cityId.ts";

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
  const cityId = useCityStore(s => s.activeCity.id);
  return enableMigration
    ? <SavedLocationsBar key={cityId} cityId={cityId} onFavoriteClick={onFavoriteClick} />
    : <LegacyFavoritesBar onFavoriteClick={onFavoriteClick} />;
}

function LegacyFavoritesBar({ onFavoriteClick }: FavoritesBarProps) {
  const favorites = useFavoritesStore((s) => s.favorites);
  const activeCityId = useCityStore((s) => s.activeCity.id);
  const loaded = usePersistHydrated(useFavoritesStore.persist);

  // Every shortcut belongs to a city, including Home/Work and coordinates.
  const cityFavorites = favorites.filter(
    (f) => f.cityId && canonicalCityId(f.cityId) === canonicalCityId(activeCityId)
  );

  if (!loaded) return <FavoritesLoading />;
  if (cityFavorites.length === 0) return null;

  const sorted = [...cityFavorites].sort(
    (a, b) => a.sortOrder - b.sortOrder
  );

  return <FavoritesRow favorites={sorted} onFavoriteClick={onFavoriteClick} />;
}

function SavedLocationsBar({ onFavoriteClick, cityId }: FavoritesBarProps & {cityId: string}) {
  const saves = useResolvedSaves();
  if (saves === null) return <FavoritesLoading />;
  // This city's single places (not route pairs), oldest first as before saves
  // were sealed.
  const places = saves
    .filter((save) => !save.destination && saveBelongsToCity(save, cityId))
    .reverse()
    .map(toFavoritePlace);
  if (places.length === 0) return null;
  return <FavoritesRow favorites={places} onFavoriteClick={onFavoriteClick} />;
}

/** Placeholder while sealed favorites are decrypted. */
function FavoritesLoading() {
  return (
    <div
      role="status"
      aria-label="Loading favorites"
      data-testid="favorites-loading"
      className="h-11 px-3 py-2"
    />
  );
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

function toFavoritePlace(save: ResolvedSave): FavoritePlace {
  const endpoint = save.origin;
  const stopId = endpoint.kind === "stop" ? endpoint.stopId : undefined;
  const type: FavoritePlace["type"] =
    save.placeType ?? (stopId ? "stop" : "place");
  return {
    id: save.id,
    cityId: save.cityId,
    name: save.alias,
    type,
    location: { lat: endpoint.lat, lon: endpoint.lon },
    stopId,
    sortOrder: -save.savedAt,
    createdAt: new Date(save.savedAt).toISOString(),
  };
}
