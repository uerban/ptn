import { useEffect } from "react";
import { useCityStore } from "../stores/cityStore.ts";
import { serverTime } from "../services/serverTime.ts";

const FETCH_TIMEOUT_MS = 3000;

/**
 * Sync `serverTime` once on mount from `/api/<city>/version` — the only
 * `NetworkOnly` route in the workbox config (`vite.config.ts` →
 * `VitePWA.workbox.runtimeCaching`). That guarantees the response's
 * `Date` header is fresh; no cache layer can substitute a stale value.
 *
 * Mount at the app root, not inside a page that's gated behind navigation.
 * Earlier iterations co-located the sync with `useBackendBuildInfo` (which
 * powers the Settings page's version block); the result was that any
 * session where the user never opened Settings ran on raw `Date.now()`
 * with no telemetry firing. This hook is purely a side effect — no UI
 * state, no return value — so it's safe to call from `App.tsx` on every
 * boot regardless of route.
 */
export function useServerTimeSync(): void {
  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const apiUrl = useCityStore.getState().getApiUrl();
        const res = await fetch(`${apiUrl}/version`, { signal: controller.signal });
        if (!res.ok) return;
        const dateHeader = res.headers.get("Date");
        if (!dateHeader) {
          // /version is the canonical sync source. A missing Date header
          // here means an intermediary stripped it — visible only via this
          // warn until someone notices `serverTime.now()` matches client
          // time across the whole session.
          console.warn(
            "[useServerTimeSync] /version response had no Date header — serverTime will not sync this session",
          );
          return;
        }
        serverTime.update(dateHeader);
      } catch {
        // AbortError or network failure — fall back to raw client time
        // for the session. The 5-minute rejection guard in
        // ServerTimeSyncer.update is the safety net if a later code path
        // ever does try to sync from a less-trustworthy source.
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);
}
