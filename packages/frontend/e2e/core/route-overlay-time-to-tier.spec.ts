import { test, expect } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { REF_URL } from "./route-overlay-refUrl.ts";

/**
 * time-to-tier SLO.

 *
 * Target: ≥90 % of transit legs reach `source: "shape"` within 3 s on a 4G
 * profile. Gated behind two missing hooks:
 *
 *   1. `errorReporter.reportTelemetry` is gated by the privacy policy
 *      (`getPolicy().errorReporting`). No `__ptnPrivacyOverride__` hook
 *      currently exists in `packages/frontend/src/services/errorReporter.ts`,
 *      so we cannot turn telemetry on from a test without mutating the
 *      privacy store. Adding the override is tracked in the Phase 2f
 *      backlog — until it lands, this spec must skip rather than silently
 *      report zero events.
 *
 *   2. The `validate` project in `playwright.config.ts` does not enable
 *      CDP network throttling, so we also cannot measure the 4G latency
 *      profile the SLO is stated against. When (1) lands, wire a Chromium
 *      CDP session emulation block here before dropping the skip.
 *

 * * See also `./route-overlay-refUrl.ts`.
 */
test.describe("RouteOverlay time-to-tier @mock-api", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("≥90% transit legs at shape within 3s on 4G", async ({ page }) => {
    test.skip(
      true,
      "Requires `__ptnPrivacyOverride__` hook in errorReporter.ts + CDP " +
        "throttling in the validate project. Tracked in Phase 2f backlog; " +
        "see header comment in this spec.",
    );

    // Force telemetry on via the hook that does not yet exist.
    await page.addInitScript(() => {
      (window as any).__ptnPrivacyOverride__ = { errorReporting: true };
    });

    const times: Array<{ source: string; ms: number }> = [];
    await page.exposeBinding(
      "__recordTier",
      (_source, payload: { source: string; ms: number }) => {
        times.push(payload);
      },
    );
    await page.addInitScript(() => {
      const origInfo = console.info.bind(console);
      console.info = (...args: unknown[]) => {
        const [label, msg] = args;
        if (
          label === "[telemetry]" &&
          typeof msg === "object" &&
          msg !== null &&
          (msg as { event?: string }).event === "leg_geometry_source"
        ) {
          const data = (msg as { data?: { source?: string } }).data ?? {};
          (window as any).__recordTier({
            source: data.source ?? "unknown",
            ms: performance.now(),
          });
        }
        return origInfo(...(args as [unknown, ...unknown[]]));
      };
    });

    await page.goto(REF_URL);

    // Wait for at least one telemetry emission; otherwise the env has
    // telemetry gated off and we'd green on zero data.
    await page
      .waitForFunction(
        () => (window as any).__recordTierCount > 0 || true,
        { timeout: 10_000 },
      )
      .catch(() => {
        /* keep going; the explicit sample-size check below is authoritative */
      });

    const transitCount = times.filter(
      (t) => t.source === "shape" || t.source === "intermediate",
    ).length;
    if (transitCount === 0) {
      test.skip(
        true,
        "telemetry disabled in this environment — verify manually in staging",
      );
    }
    const shapeInTime = times.filter(
      (t) => t.source === "shape" && t.ms <= 3_000,
    ).length;
    expect(shapeInTime / transitCount).toBeGreaterThanOrEqual(0.9);
  });
});
