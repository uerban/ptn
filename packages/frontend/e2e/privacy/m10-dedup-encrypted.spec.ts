import { test, expect, type Page } from "@playwright/test";
import { mockApi } from "../helpers/mock-api";
import { bootAtPrivacyLevel } from "../../tests/privacy-harness/bootAtLevel";
import type { PrivacyLevel } from "@pt/shared";

const ADAPTER_MODULE = "/src/services/geocoder/ThirdPartyGeocoderAdapter.ts";
const DB_MODULE = "/src/db/index.ts";

const NOMINATIM_RESPONSE = [
  {
    display_name: "Gdansk, Pomerania, Poland",
    lat: "54.3520",
    lon: "18.6466",
    importance: 0.8,
  },
];

const QUERY = "Gdansk";
const HINT = { lat: 54.352, lon: 18.6466 };

interface DedupRow {
  queryHash: string;
  ctLen: number;
  ivLen: number;
  createdAt: number;
  providerId: string;
  gridMeters: number;
  metadataJson: string;
  ctUtf8: string;
}

async function readDedupTable(page: Page): Promise<DedupRow[]> {
  return await page.evaluate(async (modulePath) => {
    const mod = (await import(/* @vite-ignore */ modulePath)) as {
      db: {
        geocoderDedup: {
          toArray: () => Promise<
            Array<{
              queryHash: string;
              ct: ArrayBuffer;
              iv: ArrayBuffer;
              createdAt: number;
              providerId: string;
              gridMeters: number;
            }>
          >;
        };
      };
    };
    const rows = await mod.db.geocoderDedup.toArray();
    const utf8 = new TextDecoder("utf-8", { fatal: false });
    return rows.map((r) => ({
      queryHash: r.queryHash,
      ctLen: r.ct.byteLength,
      ivLen: r.iv.byteLength,
      createdAt: r.createdAt,
      providerId: r.providerId,
      gridMeters: r.gridMeters,
      // Plaintext metadata only — excludes ct/iv which are checked separately.
      metadataJson: JSON.stringify({
        queryHash: r.queryHash,
        createdAt: r.createdAt,
        providerId: r.providerId,
        gridMeters: r.gridMeters,
      }),
      // Lossy UTF-8 decode of the ciphertext bytes. AES-GCM output is
      // indistinguishable from random, so plaintext substrings will not
      // appear here unless encryption was bypassed.
      ctUtf8: utf8.decode(new Uint8Array(r.ct)),
    }));
  }, DB_MODULE);
}

async function runForwardQuery(
  page: Page,
  hint: { lat: number; lon: number } | null,
): Promise<void> {
  await page.evaluate(
    async ({ modulePath, q, h }) => {
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        ThirdPartyGeocoderAdapter: new (
          config: { provider: string; endpoint: string },
          getPolicy: () => {
            m10ThirdPartyEnabled: boolean;
            m10CoarsenGridDefaultMeters: number;
          },
        ) => {
          forward: (
            q: string,
            hint: { lat: number; lon: number } | null,
            signal: AbortSignal,
          ) => Promise<unknown>;
        };
      };
      const adapter = new mod.ThirdPartyGeocoderAdapter(
        {
          provider: "nominatim",
          endpoint: "https://nominatim.openstreetmap.org",
        },
        () => ({
          m10ThirdPartyEnabled: true,
          m10CoarsenGridDefaultMeters: 500,
        }),
      );
      await adapter.forward(q, h, new AbortController().signal);
    },
    { modulePath: ADAPTER_MODULE, q: QUERY, h: hint },
  );
}

async function tryForwardExpectingFailure(page: Page): Promise<string | null> {
  return await page.evaluate(
    async ({ modulePath, q, h }) => {
      const mod = (await import(/* @vite-ignore */ modulePath)) as {
        ThirdPartyGeocoderAdapter: new (
          config: { provider: string; endpoint: string },
          getPolicy: () => {
            m10ThirdPartyEnabled: boolean;
            m10CoarsenGridDefaultMeters: number;
          },
        ) => {
          isAvailable: () => boolean;
          forward: (
            q: string,
            hint: { lat: number; lon: number } | null,
            signal: AbortSignal,
          ) => Promise<unknown>;
        };
      };
      // Mirror the production boot: the adapter only exists where M10 third-
      // party is enabled. When disabled we still instantiate it with the
      // current policy (disabled) so `isAvailable()` is false and `forward()`
      // throws — proving both that registration gating is honored AND that
      // no dedup write slips through if the gate is bypassed.
      const adapter = new mod.ThirdPartyGeocoderAdapter(
        {
          provider: "nominatim",
          endpoint: "https://nominatim.openstreetmap.org",
        },
        () => ({
          m10ThirdPartyEnabled: false,
          m10CoarsenGridDefaultMeters: 500,
        }),
      );
      if (adapter.isAvailable()) return "unexpectedly-available";
      try {
        await adapter.forward(q, h, new AbortController().signal);
        return "forward-did-not-throw";
      } catch (e) {
        return (e as Error).message;
      }
    },
    { modulePath: ADAPTER_MODULE, q: QUERY, h: HINT },
  );
}

test.describe("M10 v2: no plaintext dedup entries at any level @mock-api", () => {
  // Baseline, Standard, Hardened: M10 third-party either default-on (Baseline,
  // Standard) or user-enabled via settings override (Hardened). In all three
  // cases a dedup write must land encrypted.
  const ENABLED_LEVELS = ["baseline", "standard", "hardened"] as const;

  for (const level of ENABLED_LEVELS) {
    test(`two identical queries hit cache exactly once and store encrypted at ${level}`, async ({
      page,
    }) => {
      await bootAtPrivacyLevel(page, level, {
        m10ThirdPartyEnabled: true,
      });
      await mockApi(page);

      const outbound: Array<{ url: string }> = [];
      await page.route("https://nominatim.openstreetmap.org/**", (route) => {
        outbound.push({ url: route.request().url() });
        route.fulfill({ json: NOMINATIM_RESPONSE });
      });

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // First call — outbound fetch, writes dedup entry.
      await runForwardQuery(page, HINT);
      // Second identical call — must hit cache, no outbound fetch.
      await runForwardQuery(page, HINT);

      expect(outbound, "dedup should collapse the second call").toHaveLength(1);

      const rows = await readDedupTable(page);
      expect(rows, "exactly one cached row per unique query").toHaveLength(1);

      const [row] = rows;
      expect(row!.ctLen, "ciphertext must be populated").toBeGreaterThan(0);
      expect(row!.ivLen, "iv must be 12 bytes per AES-GCM").toBe(12);

      // No plaintext query or response fields in the metadata.
      expect(row!.metadataJson).not.toContain(QUERY);
      expect(row!.metadataJson).not.toContain("Gdansk, Pomerania, Poland");
      expect(row!.metadataJson).not.toContain("display_name");
      // Ciphertext bytes must not contain plaintext fragments either. A
      // regression that skipped encryption and wrote the JSON payload into
      // ct would trip these checks.
      expect(row!.ctUtf8).not.toContain(QUERY);
      expect(row!.ctUtf8).not.toContain("Gdansk, Pomerania, Poland");
      expect(row!.ctUtf8).not.toContain("display_name");
      // The queryHash is a SHA-256 hex (64 chars); it is a one-way derivative
      // of the plaintext query + coarsened coord and is not itself PII.
      expect(row!.queryHash).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  // Strict + Paranoid: production does not register the third-party adapter.
  // Even under simulated misuse (instantiating it anyway) isAvailable() is
  // false, forward() throws, and the dedup table stays empty.
  const DISABLED_LEVELS = ["strict", "paranoid"] as const satisfies ReadonlyArray<PrivacyLevel>;

  for (const level of DISABLED_LEVELS) {
    test(`dedup table remains empty at ${level} after simulated activity`, async ({
      page,
    }) => {
      await bootAtPrivacyLevel(page, level);
      await mockApi(page);

      const outbound: Array<{ url: string }> = [];
      await page.route("https://nominatim.openstreetmap.org/**", (route) => {
        outbound.push({ url: route.request().url() });
        route.fulfill({ json: NOMINATIM_RESPONSE });
      });

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const failureMessage = await tryForwardExpectingFailure(page);
      expect(failureMessage).toContain("disabled");

      expect(outbound, "no outbound request at locked-down level").toHaveLength(0);

      const rows = await readDedupTable(page);
      expect(rows, "geocoderDedup must be empty").toHaveLength(0);
    });
  }
});
