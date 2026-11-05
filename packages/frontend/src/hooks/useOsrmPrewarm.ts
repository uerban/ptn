import { useEffect } from "react";
import { osrmClient } from "../services/osrmWasm.ts";

// Module-scoped one-time-log flag for the iOS-no-op path. Mirrors the
// `logDisabledOnce` pattern in osrmWasm.ts so operators can correlate
// "users on Safari report slower first searches" with the design choice
// rather than a regression.
let iosNoopLogged = false;
function logIosNoopOnce(): void {
  if (iosNoopLogged) return;
  iosNoopLogged = true;
  console.info(
    "[osrm-prewarm] disabled — requestIdleCallback unavailable. " +
      "First search will use the search-time race + radius fallback path.",
  );
}

/**
 * Prewarm OSRM during page idle so the first user search benefits from
 * OSRM-quality results (closes D-030).
 *
 * No-op when:
 * - `cityId` is the empty string.
 * - `window.requestIdleCallback` is unavailable (iOS Safari). Running the
 *   WASM init via a `setTimeout(0)` polyfill defeats the purpose: the
 *   macrotask lands during the post-load idle window that TBT (Total
 *   Blocking Time) measures, pushing the budget. On iOS we accept the
 *   first-search-fallback cost; the search-time race in
 *   `searchOrchestrator.ts` handles it via the radius-based path. A
 *   one-time `console.info` surfaces this state for observability.
 *
 * `osrmClient.init` is idempotent under the *same* cityId (gated on
 * `this.ready || this.loading`). It is NOT keyed on cityId — switching
 * cities mid-load will short-circuit the new init and leave the OSRM
 * graph bound to the previous city. That's a pre-existing footgun in
 * the client, out of scope for this hook; future work should add
 * `osrmClient.destroy()` and call it when `cityId` changes.
 */
export function useOsrmPrewarm(cityId: string): void {
  useEffect(() => {
    if (!cityId) return;
    if (typeof window === "undefined") return;
    if (typeof window.requestIdleCallback !== "function") {
      logIosNoopOnce();
      return;
    }

    const handle = window.requestIdleCallback(() => {
      osrmClient.init(cityId).catch((err) => {
        // Failure modes include 404 on the city OSRM bundle (operator
        // misconfig — most likely cause), network failure, WASM
        // corruption, OOM. The orchestrator's search-time race + radius
        // fallback covers transient timing — but persistent failures
        // would otherwise be invisible to operators. Log enough context
        // to diagnose without spamming on every page load.
        console.warn(
          `[osrm-prewarm] init failed for cityId=${cityId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    });

    return () => {
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(handle);
      }
    };
  }, [cityId]);
}

// Test-only: reset the one-time log flag so tests can verify the log
// fires on the first invocation per test. Not exported in the public
// surface; callers should not use this in production code.
export function __resetIosNoopLogForTests(): void {
  iosNoopLogged = false;
}
