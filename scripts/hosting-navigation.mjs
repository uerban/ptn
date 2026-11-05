// Docker network changes can briefly interrupt Chromium navigation.
export async function navigate(page, url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url);
    } catch (error) {
      if (attempt >= 3 || !String(error.message).includes("net::ERR_NETWORK_CHANGED")) throw error;
      console.warn(`Navigation interrupted by a network change; retrying (${attempt}/2)`);
    }
  }
}
