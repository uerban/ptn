import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createTolerantJSONStorage } from "../services/tolerantLocalStorage.ts";
import { CITIES, type CityConfig, getAvailableCities } from "../config/cities.ts";
import { CITY_STORAGE_KEY, canonicalCityId } from "../utils/cityId.ts";

// Re-export so existing import paths keep working.
export { getAvailableCities };

interface CityState {
  activeCity: CityConfig;
  setActiveCity: (city: CityConfig) => void;
  getApiUrl: () => string;
}

export const useCityStore = create<CityState>()(
  persist(
    (set, get) => ({
      activeCity: getAvailableCities()[0],
      // Selection changes identity only. Modern artifacts own their retention;
      // legacy recovery rows must not create writes on this critical path.
      setActiveCity: (city) => set({activeCity: city}),
      getApiUrl: () => `/api/${get().activeCity.id}`,
    }),
    {
      name: CITY_STORAGE_KEY,
      storage: createTolerantJSONStorage(),
      // Keep only identity on disk; metadata comes from the current catalog.
      partialize: (state) => ({currentCityId: state.activeCity.id}),
      merge: (persisted, current) => {
        const stored = persisted as {currentCityId?: string; activeCity?: CityConfig} | undefined;
        const rawId = stored?.currentCityId ?? stored?.activeCity?.id;
        const storedId = rawId ? canonicalCityId(rawId) : rawId;
        const available = new Set(getAvailableCities().map((c) => c.id));
        const match = storedId ? CITIES.find((c) => c.id === storedId && available.has(c.id)) : undefined;
        return {
          ...current,
          activeCity: match ?? current.activeCity,
        };
      },
    }
  )
);
