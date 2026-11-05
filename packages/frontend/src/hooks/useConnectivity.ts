import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getSnapshot() {
  return navigator.onLine;
}

function getServerSnapshot() {
  return true;
}

/** Reactive hook that tracks online/offline status */
export function useConnectivity(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * One-shot, injectable online probe for imperative classification (the remote-primary fallback
 * **banner copy** — offline vs server-unavailable). The reactive `useConnectivity` hook above
 * is for render; this is for effect-time reads. SSR-safe.

 *

 * * NOTE: online state only *picks the copy*. The remote→on-device fallback fires on the
 * `plan()` rejection itself, never on this flag.
 */
export function isDeviceOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}
