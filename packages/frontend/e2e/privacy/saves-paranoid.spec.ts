import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";

/**
 * M8c T-24 — Paranoid saves persist across reload with the alias sealed inside
 * the encrypted payload.
 *
 * Boots the app at `paranoid`, invokes `saveRoutePair` via a dynamic import
 * against the real service (same pattern as `favorites-to-saves.spec.ts`),
 * reloads, and then inspects `savedLocations` directly through `indexedDB`
 * to verify three contracts:
 *   1. the row survives the reload,
 *   2. the plaintext `alias` column is blanked (the label must live inside
 *      `aliasCipher` at `always-no-share`, per `shouldEncryptAlias`),
 *   3. the alias string never appears verbatim anywhere in the persisted row
 *      — including inside `endpoint` / `destinationEndpoint` ciphertext — so
 *      a raw IDB dump can't leak the label.
 *
 * Tagged @mock-api because it boots the real app against deterministic
 * fixtures (required for `/src/...` dynamic imports served by Vite).
 */

const SAVES_MODULE_URL = "/src/services/saves.ts";
const CRYPTO_BOX_MODULE_URL = "/src/services/cryptoBox.ts";
const INSTALL_KEY_MODULE_URL = "/src/services/installKey.ts";

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

interface RawSavedRow {
  id: string;
  alias: string;
  encrypted: boolean;
  hasAliasCipher: boolean;
  rowJson: string;
  decryptedAlias?: string;
  decryptedOriginLabel?: string;
  decryptedDestinationLabel?: string;
}

async function readRawSavedRow(
  page: Page,
  id: string,
): Promise<RawSavedRow | null> {
  return await page.evaluate(
    async ({ cryptoUrl, keyUrl, rowId }) => {
      const crypto = (await import(/* @vite-ignore */ cryptoUrl)) as {
        decrypt: (
          rec: { iv: ArrayBuffer; ct: ArrayBuffer },
          key: CryptoKey,
        ) => Promise<unknown>;
      };
      const installKey = (await import(/* @vite-ignore */ keyUrl)) as {
        getOrCreateInstallKey: () => Promise<CryptoKey>;
      };

      return await new Promise<RawSavedRow | null>((resolve, reject) => {
        const req = indexedDB.open("ptn");
        req.onsuccess = async () => {
          try {
            const idb = req.result;
            const tx = idb.transaction("savedLocations", "readonly");
            const store = tx.objectStore("savedLocations");
            const raw = await new Promise<unknown>((res, rej) => {
              const r = store.get(rowId);
              r.onsuccess = () => res(r.result);
              r.onerror = () => rej(r.error);
            });
            if (!raw) {
              idb.close();
              resolve(null);
              return;
            }
            const row = raw as {
              id: string;
              alias: string;
              encrypted: boolean;
              aliasCipher?: { iv: ArrayBuffer; ct: ArrayBuffer };
              endpoint: { iv: ArrayBuffer; ct: ArrayBuffer };
              destinationEndpoint?: { iv: ArrayBuffer; ct: ArrayBuffer };
            };
            const rowJson = JSON.stringify(row);
            const out: RawSavedRow = {
              id: row.id,
              alias: row.alias,
              encrypted: row.encrypted,
              hasAliasCipher: row.aliasCipher !== undefined,
              rowJson,
            };
            const key = await installKey.getOrCreateInstallKey();
            if (row.aliasCipher) {
              out.decryptedAlias = (await crypto.decrypt(
                row.aliasCipher,
                key,
              )) as string;
            }
            if (row.encrypted && row.endpoint) {
              const originBack = (await crypto.decrypt(
                row.endpoint,
                key,
              )) as { name?: string; label?: string };
              out.decryptedOriginLabel = originBack.name ?? originBack.label;
            }
            if (row.encrypted && row.destinationEndpoint) {
              const destBack = (await crypto.decrypt(
                row.destinationEndpoint,
                key,
              )) as { name?: string; label?: string };
              out.decryptedDestinationLabel =
                destBack.label ?? destBack.name;
            }
            idb.close();
            resolve(out);
          } catch (e) {
            reject(e);
          }
        };
        req.onerror = () => reject(req.error);
      });
    },
    {
      cryptoUrl: CRYPTO_BOX_MODULE_URL,
      keyUrl: INSTALL_KEY_MODULE_URL,
      rowId: id,
    },
  );
}

test.describe("Privacy: Paranoid saves @mock-api", () => {
  test("save persists across reload with alias sealed in ciphertext", async ({
    page,
  }) => {
    await bootAtPrivacyLevel(page, "paranoid");
    await mockApi(page);

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    const ROW_ID = "paranoid-save-1";
    await seedSave(page, ROW_ID);

    // Pre-reload invariants: row is encrypted, alias plaintext column blanked,
    // aliasCipher present, and the alias string is nowhere in the raw row.
    const preRow = await readRawSavedRow(page, ROW_ID);
    expect(preRow).not.toBeNull();
    expect(preRow!.encrypted).toBe(true);
    expect(preRow!.alias).toBe("");
    expect(preRow!.hasAliasCipher).toBe(true);
    expect(preRow!.rowJson).not.toContain(ALIAS);
    expect(preRow!.rowJson).not.toContain(ORIGIN.name);
    expect(preRow!.rowJson).not.toContain(DESTINATION.label);
    expect(preRow!.decryptedAlias).toBe(ALIAS);
    expect(preRow!.decryptedOriginLabel).toBe(ORIGIN.name);
    expect(preRow!.decryptedDestinationLabel).toBe(DESTINATION.label);

    // ── Reload the app ────────────────────────────────────────────────────
    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // ── Post-reload: save still there, alias still sealed ─────────────────
    const postRow = await readRawSavedRow(page, ROW_ID);
    expect(postRow).not.toBeNull();
    expect(postRow!.id).toBe(ROW_ID);
    expect(postRow!.encrypted).toBe(true);
    // The plaintext `alias` column must remain blank at Paranoid — this is
    // the load-bearing contract. A regression that re-stored the alias in
    // plaintext (e.g. by dropping `shouldEncryptAlias`) would surface here.
    expect(postRow!.alias).toBe("");
    expect(postRow!.hasAliasCipher).toBe(true);

    // IDB inspection: the alias must not appear verbatim anywhere in the
    // persisted row (plaintext column, aliasCipher buffer, endpoint
    // ciphertext, metadata). JSON.stringify renders buffers as objects, so
    // any stray plaintext would show up.
    expect(postRow!.rowJson).not.toContain(ALIAS);
    expect(postRow!.rowJson).not.toContain(ORIGIN.name);
    expect(postRow!.rowJson).not.toContain(DESTINATION.label);

    // Decryptable round-trip proves the sealed alias survived the reload.
    expect(postRow!.decryptedAlias).toBe(ALIAS);
    expect(postRow!.decryptedOriginLabel).toBe(ORIGIN.name);
    expect(postRow!.decryptedDestinationLabel).toBe(DESTINATION.label);
  });
});
