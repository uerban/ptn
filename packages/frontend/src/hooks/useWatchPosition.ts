import { useCallback, useSyncExternalStore } from "react";
import { liveLocation } from "../services/liveLocation.ts";

/** Subscribe to the shared foreground watch without prompting for permission. */
export function useWatchPosition(enabled: boolean) {
  const subscribe = useCallback((listener: () => void) =>
    enabled ? liveLocation.subscribe(listener) : () => {}, [enabled]);
  const state = useSyncExternalStore(subscribe, liveLocation.getSnapshot);
  return enabled ? state : {
    position: null, speed: null, heading: null, accuracy: null,
    timestamp: null, loading: false, error: null, paused: false, requestId: 0,
  };
}
