/**
 * Park the RT poller for suites that start navigation or a line preview but do
 * not test real-time updates.
 *
 * jsdom has no RT backend, so every poll the RT store starts would reject and
 * log a warning — asynchronously, often after the file's last test has
 * finished. Vitest 4 fails the whole run when a console call races the
 * worker's teardown. A fetch that never settles keeps the poller idle and
 * silent instead. Call it in `beforeEach`, after any `vi.restoreAllMocks()`.
 */
import { vi } from "vitest";
import { api } from "../../src/services/api.ts";

export function parkRtPolling(): void {
  vi.spyOn(api, "fetchRouteRt").mockReturnValue(new Promise(() => {}));
}
