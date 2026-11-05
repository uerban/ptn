import { useCallback } from "react";
import { useWatchPosition } from "./useWatchPosition.ts";
import { liveLocation } from "../services/liveLocation.ts";

export function useGeolocation() {
  const state = useWatchPosition(true);
  const requestLocation = useCallback(() => { liveLocation.request("locate"); }, []);
  return { location: state.position, loading: state.loading, error: state.error, requestLocation };
}
