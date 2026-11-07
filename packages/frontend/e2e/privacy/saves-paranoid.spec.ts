import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { rawStorageDump, rowShapes } from "../helpers/raw-storage";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";

/**
 * Paranoid saves persist across reload, sealed whole.
 *
 * Boots the app at `paranoid`, invokes `saveRoutePair` via a dynamic import
 * against the real service, reloads, and inspects `savedLocations` directly
 * through `indexedDB`:
 *   1. the row survives the reload and still resolves to its label and
 *      endpoints,
 *   2. the stored row carries only an id and a sealed payload,
 *   3. neither the label nor any endpoint name appears anywhere in the raw
 *      IndexedDB or localStorage contents.
 *
 * Tagged @mock-api because it boots the real app against deterministic
 * fixtures (required for `/src/...` dynamic imports served by Vite).
 */

const SAVES_MODULE_URL = "/src/services/saves.ts";

const ALIAS = "Therapist";
const ORIGIN = {
  kind: "stop",
  stopId: "S-sens-1",
  name: "Sensitive Origin",
  lat: 54.6872,
  lon: 25.2797,
} as const;
const DESTINATION = {
  kind: "geocoded",
  lat: 54.6876,
  lon: 25.2808,
  label: "Sensitive Destination",
  provider: "third-party-nominatim",
  confidence: 0.9,
} as const;

// Coordinates are left out: the origin sits on the city centre, which the
// selected-city record stores in plaintext.
const SENSITIVE = [ALIAS, ORIGIN.name, ORIGIN.stopId, DESTINATION.label, "54.6876"];

async function seedSave(page: Page, id: string): Promise<void> {
  await page.evaluate(
    async ({ moduleUrl, origin, destination, alias, rowId }) => {
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
        saveRoutePair: (
          input: {
            origin: typeof origin;
            destination: typeof destination;
            alias?: string;
          },
          opts?: { id?: string },
        ) => Promise<unknown>;
      };
      await mod.saveRoutePair(
        { origin, destination, alias },
        { id: rowId },
      );
    },
    {
      moduleUrl: SAVES_MODULE_URL,
      origin: ORIGIN,
      destination: DESTINATION,
      alias: ALIAS,
      rowId: id,
    },
  );
}

async function listSaves(page: Page) {
  return await page.evaluate(async (moduleUrl) => {
    const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
      listSaves: () => Promise<
        { id: string; alias: string; origin: { name?: string }; destination?: { label?: string } }[]
      >;
    };
    return await mod.listSaves();
  }, SAVES_MODULE_URL);
}

test.describe("Privacy: Paranoid saves @mock-api", () => {
  test("save persists across reload and is stored sealed whole", async ({ page }) => {
    await bootAtPrivacyLevel(page, "paranoid");
    await mockApi(page);

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    const ROW_ID = "paranoid-save-1";
    await seedSave(page, ROW_ID);

    expect(await rowShapes(page, "savedLocations")).toEqual([["id", "sealed"]]);
    let raw = await rawStorageDump(page);
    for (const needle of SENSITIVE) expect(raw).not.toContain(needle);

    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    const saves = await listSaves(page);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.id).toBe(ROW_ID);
    expect(saves[0]!.alias).toBe(ALIAS);
    expect(saves[0]!.origin.name).toBe(ORIGIN.name);
    expect(saves[0]!.destination?.label).toBe(DESTINATION.label);

    raw = await rawStorageDump(page);
    for (const needle of SENSITIVE) expect(raw).not.toContain(needle);
  });
});
