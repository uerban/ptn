import { test } from "@playwright/test";
import { runPaddingScenario } from "../helpers/m11-padding";

// M11 T-16 — Hardened tile padding.
//
// At `hardened`, `policy.m11TileDefense` is `"prefetch-padding"`. Every dynamic
// (post-prefetch, cache-miss) tile load must be accompanied by ≥ 2 decoy tile
// loads whose keys lie in the city tile space but OUTSIDE the current
// viewport. The decoy-timer axis is NOT in scope at Hardened — that's exercised
// by the Paranoid spec.
//
// The UI wiring for the defense dispatcher is deferred (notes); this spec orchestrates the
// production `dispatchTileLoad` directly against the real `/api/gtfs/poi-tile/...` URL shape to
// prove the policy branch composes end-to-end, then hits the assertion via the shared padding
// helper.

test.describe("M11 T-16: Hardened tile padding @mock-api", () => {
  test("dynamic tile loads are accompanied by ≥ 2 outside-viewport decoys", async ({
    page,
  }) => {
    await runPaddingScenario(page, "hardened");
  });
});
