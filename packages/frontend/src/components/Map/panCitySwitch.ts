import type {Map} from "maplibre-gl";
import {findCityByLocation, getAvailableCities} from "../../config/cities.ts";
import {useCityStore} from "../../stores/cityStore.ts";

/** Coalesce terminal gesture events without delaying every settled city entry
 * by half a second. Recheck motion because a flight can start during the wait. */
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
      }, 200);
    },
  };
}
