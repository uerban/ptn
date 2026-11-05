import { test } from "@playwright/test";
import { runPaddingScenario } from "../helpers/m11-padding";

// M11 T-16 — Strict tile padding.
//
// At `strict`, `policy.m11TileDefense` is `"prefetch-padding-decoy"`. The per-call padding behavior
// is identical to Hardened (≥ 2 outside-viewport decoys per dynamic load) — the additional axis at
// Strict is the background decoy-on-timer loop, which the Paranoid spec verifies. This spec focuses
// on the per-call assertion so a regression that silently drops padding when the timer strategy is
// active is caught here rather than slipping past the Paranoid timing assertions.
//
// The UI wiring for the defense dispatcher is deferred (notes); this spec orchestrates the
// production `dispatchTileLoad` directly against the real `/api/gtfs/poi-tile/...` URL shape to
// prove the policy branch composes end-to-end, then hits the assertion via the shared padding
// helper.

test.describe("M11 T-16: Strict tile padding @mock-api", () => {
  test("dynamic tile loads are accompanied by ≥ 2 outside-viewport decoys", async ({
    page,
  }) => {
    await runPaddingScenario(page, "strict");
  });
});
