import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";

/**
 * M8a T-6 — site-data clear destroys the install key.
 *
 * Contract under test: clearing browser site data (cookies, permissions, and
 * `indexedDB.deleteDatabase("ptn")`) removes the non-extractable install key.
 * After reload the app regenerates a fresh key; ciphertext produced under the
 * old key is no longer decryptable. Per M8a scope the key is local and
 * un-recoverable — this spec is the behavioral proof of that guarantee.
 *
 * Tagged @mock-api because we boot the real app (not just a blank page) and
 * want deterministic fixtures. That also restricts the spec to projects that
 * run against the Vite dev server, which is required for the `/src/...`
 * dynamic import below.
 */

type HexPair = { iv: string; ct: string };

// The dev server serves source modules at their source path. We use a dynamic
// import to invoke the real `getOrCreateInstallKey()` from the browser context
// so the test exercises the production code path, not a re-implementation.
const INSTALL_KEY_MODULE_URL = "/src/services/installKey.ts";

async function goToSeedPage(page: Page) {
  await page.route("**/seed-blank", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>seed</body></html>",
    }),
  );
  await page.goto("/seed-blank");
  await page.unroute("**/seed-blank");
}

async function createInstallKeyAndEncrypt(
  page: Page,
  plaintext: string,
): Promise<HexPair> {
  return await page.evaluate(
    async ({ moduleUrl, pt }) => {
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
        getOrCreateInstallKey: () => Promise<CryptoKey>;
      };
      const key = await mod.getOrCreateInstallKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(pt);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoded,
      );
      const toHex = (buf: ArrayBuffer) =>
        Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      return { iv: toHex(iv.buffer), ct: toHex(ct) };
    },
    { moduleUrl: INSTALL_KEY_MODULE_URL, pt: plaintext },
  );
}

async function tryDecryptWithCurrentInstallKey(
  page: Page,
  payload: HexPair,
): Promise<{ ok: boolean; name?: string }> {
  return await page.evaluate(
    async ({ moduleUrl, iv, ct }) => {
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
        getOrCreateInstallKey: () => Promise<CryptoKey>;
      };
      const key = await mod.getOrCreateInstallKey();
      const fromHex = (hex: string) => {
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) {
          out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
      };
      try {
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromHex(iv) },
          key,
          fromHex(ct),
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, name: (e as Error).name };
      }
    },
    { moduleUrl: INSTALL_KEY_MODULE_URL, iv: payload.iv, ct: payload.ct },
  );
}

async function deleteIdb(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("ptn");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      }),
  );
}

async function clearSiteData(page: Page, context: BrowserContext) {
  await context.clearCookies();
  await context.clearPermissions();
  // Release Dexie's open handle on `ptn` before deleting — otherwise the
  // request fires `onblocked` and the DB lingers.
  await goToSeedPage(page);
  await deleteIdb(page);
}

test.describe("Privacy: install-key destruction @mock-api", () => {
  test("clearing site data destroys install key; prior ciphertext is unreadable, app keeps running", async ({
    page,
    context,
  }) => {
    await mockApi(page);

    // ── Boot at Standard (the default level) ──────────────────────────────
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // Trigger real install-key creation via the production module, then
    // encrypt a recents-shaped payload under that key.
    const originalCiphertext = await createInstallKeyAndEncrypt(
      page,
      JSON.stringify({ endpoint: { kind: "geocoded", lat: 1, lon: 2 } }),
    );
    expect(originalCiphertext.iv).toHaveLength(24); // 12 bytes hex
    expect(originalCiphertext.ct.length).toBeGreaterThan(0);

    // Sanity: a round-trip with the SAME key must succeed (baseline for the
    // post-reload failure assertion).
    const sameSessionRoundTrip = await tryDecryptWithCurrentInstallKey(
      page,
      originalCiphertext,
    );
    expect(sameSessionRoundTrip.ok).toBe(true);

    // ── Clear site data (per plan: cookies + permissions + delete IDB) ────
    await clearSiteData(page, context);

    // ── Reload the app — install key must regenerate fresh ────────────────
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 20_000,
    });

    // Old ciphertext must be undecryptable under the regenerated key. If the
    // new key happened to equal the old one this would succeed — the failure
    // proves the install key was actually destroyed.
    const decryptAttempt = await tryDecryptWithCurrentInstallKey(
      page,
      originalCiphertext,
    );
    expect(decryptAttempt.ok).toBe(false);
    // AES-GCM auth-tag failure under a different key surfaces as OperationError.
    expect(decryptAttempt.name).toBe("OperationError");
  });
});
