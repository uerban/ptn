/**
 * Asks the service worker registration to look for a new app version.
 *
 * Browsers check for a new worker only on navigation. An app opened from the
 * home screen is usually resumed rather than reloaded, so without these checks
 * it can keep running an old version for days. We check when the app becomes
 * visible again (at most once a minute) and every hour while it stays open.
 * A found version goes into "waiting" and the update prompt offers it.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;

export function watchForUpdates(registration: { update(): Promise<unknown> }): () => void {
  let last = Date.now();
  const check = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    last = Date.now();
    registration.update().catch(() => {
      // Offline or server error: the next check tries again.
    });
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && Date.now() - last >= MIN_GAP_MS) check();
  };
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
