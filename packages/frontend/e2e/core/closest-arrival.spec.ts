import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { setFixedDate } from "../helpers/fixed-date";
import { mockApi, PTB_MATCHED_FIXED_TIME, PTB_MATCHED_STOP_QUERY } from "../helpers/mock-api";

test.use({ timezoneId: "Europe/Vilnius" });

const closestEnabled = process.env.VITE_PTN_CLOSEST_ARRIVAL === "1";
const arriveByRequired = process.env.PTN_ARRIVE_BY_EXPERIMENT === "1" || closestEnabled;

test("Arrive By respects the Closest arrival flag @mock-api", async ({ page }) => {
  test.setTimeout(60_000);
  await mockApi(page, { routingFixture: "ptb-matched" });
  if (closestEnabled) {
    const bundle = readFileSync(new URL("../fixtures/tiny-v2.ptb", import.meta.url));
    // PTFT v1 with one directed 60-second link from S1 to S2.
    const transfers = Buffer.from([0x50, 0x54, 0x46, 0x54, 1, 2, 2, 83, 49, 1, 1, 60, 2, 83, 50, 0]);
    const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    await page.route("**/api/vilnius/transfers/fetch", (route) =>
      route.fulfill({ body: transfers, contentType: "application/octet-stream" }));
    await page.route("**/api/vilnius/raptor-bundle", (route) => route.fulfill({
      body: bundle,
      contentType: "application/octet-stream",
      headers: {
        etag: `"${sha256(bundle)}"`,
        "X-PT-Raptor-Bundle-Provenance": "transfers-v1",
        "X-PT-Transfers-Artifact-Url": "/api/vilnius/transfers/fetch",
        "X-PT-Transfers-Artifact-Hash": sha256(transfers),
        "X-PT-Transfers-Artifact-Size": String(transfers.byteLength),
      },
    }));
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (!String(url).includes("ptArriveByOwner.worker")) return;
          const pending = new Set<number>();
          const send = this.postMessage.bind(this);
          this.postMessage = (message, transfer: Transferable[] = []) => {
            if (message.op === "replaceTransfers") pending.add(message.id);
            send(message, transfer);
          };
          this.addEventListener("message", ({ data }) => {
            if (pending.delete(data.id) && data.ok && data.value.transfersReady) {
              document.documentElement.dataset.arriveByTransfersReady = "true";
            }
          });
        }
      };
    });
  }
  await setFixedDate(page, PTB_MATCHED_FIXED_TIME);
  await page.goto(`/search?${PTB_MATCHED_STOP_QUERY}`);
  await expect(page.getByTestId("itinerary-card").first()).toBeVisible({ timeout: 30_000 });

  const when = page.getByTestId("when-summary");
  test.skip(!arriveByRequired && await when.count() === 0, "This build does not include Arrive By");
  await when.click();
  await page.getByRole("button", { name: "Arrive by", exact: true }).click();
  await page.getByTestId("arrive-by-date").fill("2026-05-05");
  // The picker uses Vilnius time while this PTB fixture is generated in UTC.
  await page.getByTestId("arrive-by-time").fill("11:11");
  await page.getByTestId("arrive-by-apply").click();

  const results = page.getByTestId("arrive-by-results");
  const closest = results.getByRole("button", { name: "Closest arrival", exact: true });
  const cards = results.getByTestId("itinerary-card");
  await expect(results).toHaveAttribute("data-status", "complete", { timeout: 25_000 });

  if (!closestEnabled) {
    await expect(closest).toHaveCount(0);
    await expect(cards.first()).toBeVisible();
    return;
  }

  await expect(page.locator("html")).toHaveAttribute("data-arrive-by-transfers-ready", "true");
  await closest.click();
  await expect(closest).toHaveAttribute("aria-pressed", "true");
  await expect(results.getByRole("status")).toContainText("Closest arrival by", { timeout: 25_000 });
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(/0?8:10/);
  expect(page.workers().some((worker) => /ptArriveByOwner\.worker/.test(worker.url()))).toBe(true);

  await closest.click();
  await expect(results.getByRole("status")).toContainText("latest departure first", { timeout: 25_000 });
});
