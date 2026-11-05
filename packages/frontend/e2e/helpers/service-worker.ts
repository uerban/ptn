import { type Page } from "@playwright/test";

/** Wait until an active worker can handle the next navigation. */
export async function waitForActiveServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker?.ready;
      return registration?.active?.state === "activated";
    },
    { timeout: 15_000 },
  );
}
