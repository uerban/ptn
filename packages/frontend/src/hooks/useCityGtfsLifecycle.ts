import { useEffect } from "react";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useRtStore } from "../stores/rtStore.ts";
import { useColorConfigStore } from "../stores/colorConfigStore.ts";
import { scheduleIdle, cancelIdle } from "../utils/idle.ts";

/**
 * Drives the GTFS data lifecycle for the active city. Shared by HomePage
 * (map mode) and ScheduleHome (schedule-only mode) so the reset/defer
 * policy lives in one place instead of drifting between two pages.
 *
 * Two distinct cases:
 *
 *  - Real city switch: unsubscribe RT and reset() so the previous city's
 *    index can't answer queries, then re-init promptly.
 *  - Initial load: nothing on first draw needs the RAPTOR index (urban-mode
 *    filtering fails open until it's ready; the search and line pages
 *    self-init on navigation, and the nearby-stops list is fed reactively
 *    from `db.stopGroups`), so we DON'T reset — that would wipe the warm
 *    GTFS cache and force a network re-sync — and we defer the multi-MB
 *    bundle decode + index build to idle so the map/stops/list paint first.
 *
 * The switch decision keys off the STORE's `loadedCityId` (the city whose
 * data is actually resident), NOT a per-mount ref. A per-mount ref starts
 * fresh on every mount, so a city change that happened while BOTH home
 * screens were unmounted (e.g. switched from another route) would be
 * misread as an initial load on the next mount — skipping the reset and
 * leaving the previous city's index + live RT subscriptions answering
 * under the new city. Reading the store survives unmount/remount.
 */
export function useCityGtfsLifecycle(cityId: string): void {
  useEffect(() => {
    useColorConfigStore.getState().fetchForCity(cityId);
    const gtfs = useGtfsDataStore.getState();
    // `loadedCityId` is the city the resident index was built from; null
    // before the first init completes. A non-null value that differs from
    // the target is the only thing that means "another city's data is live."
    const isCitySwitch =
      gtfs.loadedCityId !== null && gtfs.loadedCityId !== cityId;

    if (isCitySwitch) {
      useRtStore.getState().unsubscribeAll();
      void gtfs.reset().then(() => gtfs.init(cityId));
      return;
    }

    const handle = scheduleIdle(() => {
      void gtfs.init(cityId);
    });
    return () => cancelIdle(handle);
  }, [cityId]);
}
