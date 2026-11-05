import { test, expect } from "@playwright/test";
import type { PrivacyLevel } from "@pt/shared";
import {
  captureNetworkPatternAt,
  loadSnapshot,
  writeSnapshot,
  patternsEqual,
  shouldUpdateSnapshots,
  type Scenario,
} from "./snapshot";

// Per-level baseline network-pattern snapshots (T-X-4b). The five goldens
// live in `__snapshots__/boot-idle-5s.{level}.json`. At M7a none of the
// privacy axes gate a network surface beyond errorReporter (which never
// emits network traffic on its own), so the five baselines are expected to
// be identical. They diverge once M9/M10/M11 introduce tier-gated surfaces
// — that is when this harness earns its keep.
const LEVELS: PrivacyLevel[] = [
  "baseline",
  "standard",
  "hardened",
  "strict",
  "paranoid",
];

const SCENARIO: Scenario = "boot-idle-5s";

test.describe("privacy harness — baseline snapshots @mock-api", () => {
  // One test per level: isolates failures and keeps the diff readable when a
  // regression only affects one preset.
  for (const level of LEVELS) {
    test(`${SCENARIO} at ${level}`, async ({ page }) => {
      const { pattern, urls } = await captureNetworkPatternAt(
        page,
        level,
        SCENARIO,
      );

      if (shouldUpdateSnapshots()) {
        writeSnapshot(level, SCENARIO, pattern);
        return;
      }

      const golden = loadSnapshot(level, SCENARIO);
      expect(
        golden,
        `No baseline snapshot for ${level}/${SCENARIO}. Run with UPDATE_PRIVACY_SNAPSHOTS=1 to create it.`,
      ).not.toBeNull();

      expect(
        patternsEqual(pattern, golden!),
        `Network pattern drift at ${level}/${SCENARIO}.\n` +
          `Observed: ${JSON.stringify(pattern)}\n` +
          `Golden:   ${JSON.stringify(golden)}\n` +
          `Observed URLs:\n  ${urls.join("\n  ") || "(none)"}`,
      ).toBe(true);
    });
  }
});
