import type {Map} from "maplibre-gl";
import {findCityByLocation, getAvailableCities} from "../../config/cities.ts";
import {useCityStore} from "../../stores/cityStore.ts";

/** Coalesce terminal events in the same turn. moveend already establishes a
 * settled viewport; recheck motion in case another flight starts meanwhile. */
export function createPanCitySwitcher(map: Pick<Map, "getCenter" | "isMoving">) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return {
    dispose,
    schedule() {
      dispose();
      timer = setTimeout(() => {
        timer = undefined;
        if (map.isMoving()) return;
        const center = map.getCenter();
        const target = findCityByLocation(center.lat, center.lng);
        if (target && target.id !== useCityStore.getState().activeCity.id &&
            getAvailableCities().some(city => city.id === target.id)) {
          useCityStore.getState().setActiveCity(target);
        }
      }, 0);
    },
  };
}
