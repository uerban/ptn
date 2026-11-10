import type { Stop } from "@pt/shared";
import { useFavoritesStore } from "../../stores/favoritesStore.ts";
import { usePersistHydrated } from "../../hooks/usePersistHydrated.ts";
import { useCityStore } from "../../stores/cityStore.ts";
import { Icon } from "../Icon.tsx";

/** Star toggle that saves or removes a stop in the active city's favorites. */
export function StopFavoriteButton({ stop }: { stop: Pick<Stop, "id" | "name" | "location"> }) {
  const { favorites, addFavorite, removeFavorite } = useFavoritesStore();
  // Favorites are sealed and load asynchronously; editing before they load
  // would replace the stored list.
  const favoritesLoaded = usePersistHydrated(useFavoritesStore.persist);
  const activeCityId = useCityStore((s) => s.activeCity.id);

  const existing = favorites.find((f) => f.stopId === stop.id && f.cityId === activeCityId);

  function toggle() {
    if (!favoritesLoaded) return;
    if (existing) {
      removeFavorite(existing.id);
    } else {
      addFavorite({
        name: stop.name,
        type: "stop",
        location: stop.location,
        stopId: stop.id,
        cityId: activeCityId,
      });
    }
  }

  return (
    <button
      type="button"
      data-testid="stop-favorite-toggle"
      onClick={toggle}
      disabled={!favoritesLoaded}
      aria-busy={!favoritesLoaded}
      aria-pressed={!!existing}
      className="p-2 rounded-full hover:bg-surface-overlay disabled:opacity-50"
      aria-label={existing ? "Remove from favorites" : "Add to favorites"}
    >
      <Icon
        name={existing ? "star-filled" : "star-outline"}
        className={existing ? "text-favorite" : "text-fg-muted"}
      />
    </button>
  );
}
