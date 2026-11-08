import {expect, type Page} from "@playwright/test";

/** Wait until an active worker can handle the next navigation. */
export async function waitForActiveServiceWorker(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker?.getRegistration();
    return registration?.active?.state === "activated";
  }), {timeout: 15_000}).toBe(true);
}
