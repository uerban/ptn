import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FavoritePlace } from "@pt/shared";
import { useCityStore } from "./cityStore.ts";

interface FavoritesState {
  favorites: FavoritePlace[];
  addFavorite: (fav: Omit<FavoritePlace, "id" | "sortOrder" | "createdAt">) => void;
  removeFavorite: (id: string) => void;
  reorderFavorites: (ids: string[]) => void;
  assignFavoriteCity: (id: string, cityId: string) => void;
}

const scope = (cityId: string | undefined) => cityId === "gdansk" ? "tricity" : cityId;

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],

      addFavorite: (fav) => {
        const existing = get().favorites;
        const cityId = scope(fav.cityId ?? useCityStore.getState().activeCity.id)!;
        const cityOrder = existing.filter(item => scope(item.cityId) === cityId).reduce((next, item) => Math.max(next, item.sortOrder + 1), 0);
        const newFav: FavoritePlace = {
          ...fav,
          cityId,
          id: crypto.randomUUID(),
          sortOrder: cityOrder,
          createdAt: new Date().toISOString(),
        };
        set({ favorites: [...existing, newFav] });
      },

      removeFavorite: (id) => {
        const current = get().favorites;
        const removed = current.find(fav => fav.id === id);
        if (!removed) return;
        let sortOrder = 0;
        set({favorites: current.filter(fav => fav.id !== id).map(fav =>
          scope(fav.cityId) === scope(removed.cityId) ? {...fav, sortOrder: sortOrder++} : fav)});
      },

      reorderFavorites: (ids) => {
        const current = get().favorites;
        const byId = new Map(current.map((f) => [f.id, f]));
        const requested = [...new Set(ids)].filter((id) => byId.has(id));
        const selected = new Set(requested);
        // Replace only the requested slots; a city-filtered list must never
        // delete another city's favorites or unassigned legacy saves.
        let next = 0;
        const reordered = current.map((fav) => selected.has(fav.id)
          ? byId.get(requested[next++])!
          : fav);
        const cities = new Set(requested.map(id => scope(byId.get(id)!.cityId)));
        const orders = new Map<string | undefined, number>();
        set({favorites: reordered.map(fav => {
          const city = scope(fav.cityId);
          if (!cities.has(city)) return fav;
          const sortOrder = orders.get(city) ?? 0;
          orders.set(city, sortOrder + 1);
          return {...fav, sortOrder};
        })});
      },

      assignFavoriteCity: (id, cityId) => set((state) => {
        const owner = scope(cityId)!;
        const sortOrder = state.favorites.filter(fav => scope(fav.cityId) === owner).reduce((next, fav) => Math.max(next, fav.sortOrder + 1), 0);
        return {favorites: state.favorites.map(fav => fav.id === id && !fav.cityId ? {...fav, cityId: owner, sortOrder} : fav)};
      }),
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
