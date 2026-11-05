import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FavoritePlace } from "@pt/shared";

interface FavoritesState {
  favorites: FavoritePlace[];
  addFavorite: (fav: Omit<FavoritePlace, "id" | "sortOrder" | "createdAt">) => void;
  removeFavorite: (id: string) => void;
  reorderFavorites: (ids: string[]) => void;
  migrateLegacyFavorites: (cityId: string) => void;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],

      addFavorite: (fav) => {
        const existing = get().favorites;
        const newFav: FavoritePlace = {
          ...fav,
          id: crypto.randomUUID(),
          sortOrder: existing.length,
          createdAt: new Date().toISOString(),
        };
        set({ favorites: [...existing, newFav] });
      },

      removeFavorite: (id) => {
        set({
          favorites: get()
            .favorites.filter((f) => f.id !== id)
            .map((f, i) => ({ ...f, sortOrder: i })),
        });
      },

      reorderFavorites: (ids) => {
        const byId = new Map(
          get().favorites.map((f) => [f.id, f])
        );
        const reordered = ids
          .map((id) => byId.get(id))
          .filter((f): f is FavoritePlace => f !== undefined)
          .map((f, i) => ({ ...f, sortOrder: i }));
        set({ favorites: reordered });
      },

      migrateLegacyFavorites: (cityId) => {
        const current = get().favorites;
        if (current.some((f) => !f.cityId)) {
          set({
            favorites: current.map((f) => (f.cityId ? f : { ...f, cityId })),
          });
        }
      },
    }),
    {
      name: "ptn-favorites",
      merge: (persisted, current) => {
        const stored = persisted as Partial<FavoritesState> | undefined;
        if (!stored?.favorites) {
          return { ...current };
        }
        return {
          ...current,
          favorites: stored.favorites.map((f) =>
            f.cityId === "gdansk" ? { ...f, cityId: "tricity" } : f
          ),
        };
      },
    }
  )
);
