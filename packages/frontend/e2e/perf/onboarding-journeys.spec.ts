// Measures fresh-profile journeys against the mock fixtures: how many
// requests and bytes each one costs, how long until the first departure or
// planned trip is usable, and how many user actions it takes. Nothing is sent
// anywhere; results go to test-results/perf-metrics/onboarding-journeys.json
// and the test log so two builds can be compared on the same machine.
//
// Measurement only: the journeys must complete, but no time, request or byte
// budget fails the test. Timings on shared CI runners vary too much for a
// fixed limit; compare the recorded numbers between builds instead.
//
//   E2E_BASE_URL=http://localhost:5180 npx playwright test --project=perf \
//     e2e/perf/onboarding-journeys.spec.ts
//
// Against a production build (E2E_PREVIEW=1), build with VITE_E2E=1 so the
// Map journey can see when the map has drawn its stops.
import { test, expect, type Page, type Request } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  mockApi,
  PTB_MATCHED_FIXED_TIME,
  PTB_MATCHED_STOP_QUERY,
} from "../helpers/mock-api";
import { setFixedDate } from "../helpers/fixed-date";

type Preset = "recommended" | "strict";
type StartMode = "Text" | "Map";

interface Journey {
  name: string;
  preset: Preset;
  mode: StartMode;
}

const JOURNEYS: readonly Journey[] = [
  { name: "recommended-text", preset: "recommended", mode: "Text" },
  { name: "recommended-map", preset: "recommended", mode: "Map" },
  { name: "strict-text", preset: "strict", mode: "Text" },
];

interface Traffic {
  requests: number;
  bytes: number;
  /** Of which data the app asked for: /api/ calls and other origins, not code or static files. */
  dataRequests: number;
  dataBytes: number;
}

// Dev-server module requests are a property of `vite dev`, not of the app;
// they are left out so dev and preview runs stay comparable.
const DEV_MODULE = /^\/(@vite|@react-refresh|@fs|@id|src|node_modules)\//;

interface JourneyResult {
  name: string;
  /** Opening the app until the home view after setup is usable. */
  homeMs: number;
  homeActions: number;
  /** Opening the app until a stop's departures are on screen (Text) or the map has drawn its stops (Map). */
  firstDepartureMs: number;
  firstDepartureActions: number;
  firstDepartureTraffic: Traffic;
  /** Loading a planning link in the finished profile until the first itinerary is on screen. */
  firstSearchMs: number;
  totalTraffic: Traffic;
}

const results: JourneyResult[] = [];

/** Count every finished request with its transferred size (headers + body). */
function meter(page: Page): () => Traffic {
  const total: Traffic = { requests: 0, bytes: 0, dataRequests: 0, dataBytes: 0 };
  const origin = (): string => new URL(page.url()).origin;
  page.on("requestfinished", (request: Request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    const sameOrigin = url.origin === origin();
    if (sameOrigin && DEV_MODULE.test(url.pathname)) return;
    const data = !sameOrigin || url.pathname.startsWith("/api/");
    void request
      .sizes()
      .then((s) => {
        const size = s.requestHeadersSize + s.requestBodySize + s.responseHeadersSize + s.responseBodySize;
        total.requests += 1;
        total.bytes += size;
        if (data) {
          total.dataRequests += 1;
          total.dataBytes += size;
        }
      })
      .catch(() => undefined);
  });
  return () => ({ ...total });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

test.describe("@perf onboarding journeys", () => {
  test.use({ permissions: ["geolocation"] });

  for (const journey of JOURNEYS) {
    test(journey.name, async ({ page }) => {
      await mockApi(page, {
        setup: "fresh",
        realtime: journey.preset === "recommended" ? "departures, alerts" : undefined,
        routingFixture: "ptb-matched",
      });
      await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
      const traffic = meter(page);

      let actions = 0;
      const act = async (step: () => Promise<void>): Promise<void> => {
        actions += 1;
        await step();
      };

      const start = Date.now();
      await page.goto("/");
      await act(() => page.getByRole("button", { name: /^Vilnius/ }).click());
      const mode = page.getByRole("radio", { name: new RegExp(`${journey.mode} mode`) });
      if (!(await mode.isChecked())) await act(() => mode.check());
      await act(() =>
        page
          .getByRole("button", {
            name: journey.preset === "recommended" ? "Start with recommended settings" : "Start with strict privacy",
          })
          .click(),
      );
      await expect(page.getByTestId("setup-shell")).toHaveCount(0);

      let homeMs: number;
      const homeActions = actions;
      if (journey.mode === "Text") {
        await expect(page.locator("section[aria-label='Text mode']")).toBeVisible({ timeout: 15_000 });
        homeMs = Date.now() - start;
        const stop = page.getByRole("region", { name: "Nearby stops" }).getByRole("listitem").getByRole("button").first();
        await expect(stop).toBeVisible({ timeout: 15_000 });
        await act(() => stop.click());
        await expect(page.getByTestId("departure-sheet")).toBeVisible({ timeout: 10_000 });
      } else {
        await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 20_000 });
        homeMs = Date.now() - start;
        await page.waitForFunction(
          () => {
            const w = window as unknown as {
              __ptnMap?: { getSource?: (id: string) => unknown; querySourceFeatures?: (id: string) => unknown[] };
            };
            const map = w.__ptnMap;
            return !!map?.getSource?.("stops-source") && (map.querySourceFeatures?.("stops-source") ?? []).length > 0;
          },
          undefined,
          { timeout: 20_000, polling: 100 },
        );
      }
      const firstDepartureMs = Date.now() - start;
      const firstDepartureActions = actions;
      await settle(page);
      const firstDepartureTraffic = traffic();

      const searchStart = Date.now();
      await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
      await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 20_000 });
      const firstSearchMs = Date.now() - searchStart;
      await settle(page);

      const result: JourneyResult = {
        name: journey.name,
        homeMs,
        homeActions,
        firstDepartureMs,
        firstDepartureActions,
        firstDepartureTraffic,
        firstSearchMs,
        totalTraffic: traffic(),
      };
      results.push(result);
      console.log(JSON.stringify(result));
    });
  }

  test.afterAll(() => {
    const path = resolve("test-results/perf-metrics/onboarding-journeys.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
  });
});
