export type IdleHandle = number;

/**
 * Run `task` once the browser is idle — i.e. after the first paint has
 * landed — so heavy boot work doesn't compete with the critical render.
 * Falls back to a macrotask where `requestIdleCallback` is unavailable
 * (iOS Safari, jsdom). Returns a handle for `cancelIdle`.
 *
 * `requestIdleCallback` and `cancelIdleCallback` are a matched pair: a
 * platform that has one has the other, so `cancelIdle` mirrors the same
 * feature check to pick the right teardown.
 *
 * A `timeout` bounds the wait: under sustained main-thread work (continuous
 * map gestures, animations) `requestIdleCallback` can otherwise be deferred
 * indefinitely, which would leave deferred-but-needed work (e.g. the RAPTOR
 * index build) unstarted. The timeout forces it to run within the window.
 */
const IDLE_TIMEOUT_MS = 2000;

export function scheduleIdle(task: () => void): IdleHandle {
  if (typeof requestIdleCallback !== "undefined") {
    return requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS }) as unknown as IdleHandle;
  }
  return setTimeout(task, 0) as unknown as IdleHandle;
}

export function cancelIdle(handle: IdleHandle): void {
  if (typeof cancelIdleCallback !== "undefined") {
    cancelIdleCallback(handle as unknown as number);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}
