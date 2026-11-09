import { test, expect } from "@playwright/test";
import { seedCompletedSetup } from "../helpers/setup-complete";
import { createHash } from "node:crypto";

// Source of truth for the cityIds that buildAllBundles.ts emits is
// packages/backend/src/poi/cityProfiles.ts:17-44 (CITY_PROFILES record).
// As of 2026-04-25 the keys are: gdansk, gdynia, sopot, vilnius.
const EXPECTED_CITY_IDS = ["gdansk", "gdynia", "sopot", "vilnius"] as const;

test.describe("POI bundle availability", () => {
  test.beforeEach(async ({ page }) => {
    await seedCompletedSetup(page, { cityId: "vilnius" });
  });

  test("manifest covers every expected city and matches each bundle's hash", async ({ request }) => {
    const manifestRes = await request.get("/poi/manifest.json");
    expect(manifestRes.ok(), "GET /poi/manifest.json").toBe(true);

    const manifest = (await manifestRes.json()) as {
      generatedAt: number;
      bundles: Array<{ cityId: string; filename: string; sha256: string; sizeBytes: number }>;
    };

    const cityIds = manifest.bundles.map((b) => b.cityId).sort();
    expect(cityIds, "every expected cityId present in manifest").toEqual([...EXPECTED_CITY_IDS].sort());

    expect(manifest.generatedAt, "manifest generatedAt is in the past").toBeLessThanOrEqual(Date.now());

    for (const entry of manifest.bundles) {
      expect(entry.sizeBytes, `${entry.filename} sizeBytes > 0`).toBeGreaterThan(0);
      const res = await request.get(`/poi/${entry.filename}`);
      expect(res.status(), `GET /poi/${entry.filename}`).toBe(200);
      const body = await res.body();
      expect(body.length).toBe(entry.sizeBytes);
      const got = createHash("sha256").update(body).digest("hex");
      expect(got, `sha256 of ${entry.filename}`).toBe(entry.sha256);
    }
  });

  test("home page renders without the POI-unavailable banner", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=POI data unavailable")).toHaveCount(0);
  });
});
