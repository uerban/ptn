import { useLiveQuery } from "dexie-react-hooks";
import type { DependencyList } from "react";
import { captureCityData, useCityDataStore, StaleCityDataError, type CityDataRead } from "../services/cityData.ts";
import { useCityStore } from "../stores/cityStore.ts";

/** Reactive legacy-IDB or in-memory read. Never expose the old query's value
 * while a replacement city/generation is still resolving. */
export function useCityDataQuery<T>(query: (data: CityDataRead) => Promise<T>, dependencies: DependencyList): T | undefined {
  const cityId = useCityStore(state => state.activeCity.id);
  const revision = useCityDataStore(state => state.revision);
  const result = useLiveQuery(async () => {
    const data = captureCityData(cityId);
    try {
      const value = await query(data);
      data.assertCurrent();
      return {cityId, revision, value};
    } catch (error) {
      if (error instanceof StaleCityDataError) return {cityId, revision, value: undefined};
      throw error;
    }
  }, [cityId, revision, ...dependencies]);
  return result?.cityId === cityId && result.revision === revision ? result.value : undefined;
}
