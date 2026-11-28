/**
 * Keeps an installed app from running an old version indefinitely.
 *
 * With `registerType: "prompt"` a new worker waits until the rider accepts the
 * update prompt. The precache keeps serving the old app meanwhile, even across
 * a full close and reopen, so a rider who never taps the prompt stays on the
 * old version for good. Two rules fix that:
 *
 * - At launch, a version that is already waiting, or that the launch check
 *   finds within the first seconds, is applied before the rider starts using
 *   the app (one reload right after opening).
 * - While the app stays open, it checks hourly; a version found then is
 *   offered by the prompt and never forced mid-use.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const LAUNCH_WINDOW_MS = 10 * 1000;

type Worker = Pick<ServiceWorker, "state" | "postMessage" | "addEventListener">;
export interface Registration {
  update(): Promise<unknown>;
  waiting: Worker | null;
  installing: Worker | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  removeEventListener(type: "updatefound", listener: () => void): void;
}

/** Tells a waiting worker to take over, then reloads once onto the new version. */
function activate(worker: Worker): void {
  let reloaded = false;
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  worker.postMessage({ type: "SKIP_WAITING" });
}

export function watchForUpdates(registration: Registration, now: () => number = Date.now): () => void {
  const launchedAt = now();
  if (registration.waiting) {
    activate(registration.waiting);
    return () => {};
  }
  const onFound = () => {
    const worker = registration.installing;
    if (!worker || now() - launchedAt > LAUNCH_WINDOW_MS) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && now() - launchedAt <= LAUNCH_WINDOW_MS) activate(worker);
    });
  };
  registration.addEventListener("updatefound", onFound);
  const timer = setInterval(() => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    registration.update().catch(() => {
      // Offline or server error: the next check tries again.
    });
  }, UPDATE_CHECK_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    registration.removeEventListener("updatefound", onFound);
  };
}
