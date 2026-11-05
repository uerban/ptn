/**
 * The routes the RT poller currently holds, sorted.
 *
 * Reads the poller's private `subscriptions` map on purpose: a surface's
 * counted hold (`retainRoutes` / `useRetainRoutes`) is observable there
 * without a network round trip. Suites that read it keep the poller off the
 * network (`poller.start` stubbed, or a fetch that never settles).
 */
import { useRtStore } from "../../src/stores/rtStore.ts";

export function polledRoutes(): string[] {
  const poller = useRtStore.getState().poller as unknown as { subscriptions: Map<string, unknown> };
  return [...poller.subscriptions.keys()].sort();
}
