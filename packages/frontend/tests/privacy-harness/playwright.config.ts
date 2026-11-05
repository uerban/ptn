import { defineConfig, devices } from "@playwright/test";

// Sibling of the root playwright.config.ts, scoped to the privacy harness
// only. T-X-4c will wire `pnpm test:privacy-harness` (and CI) to invoke
// Playwright with this config, keeping the main e2e:* scripts unchanged.
const baseURL = process.env.E2E_BASE_URL;

export default defineConfig({
  // Hoisted to the frontend package root so the harness can include specs
  // from both `tests/privacy-harness/` and `e2e/privacy/` under one run.
  testDir: "../..",
  // Per-level baseline snapshots + harness smoke spec (lives outside `e2e/`,
  // so this config is its only entry point) + the M7b Paranoid map-tap
  // guarantee spec, which must share the harness recorder/boot primitives.
  // The M10 v2 dedup spec is also included so the threat-model harness
  // verifies "no plaintext dedup entries at any level" on every perf run.
  testMatch: [
    /tests\/privacy-harness\/(baseline|smoke)\.spec\.ts$/,
    /e2e\/privacy\/map-tap-paranoid\.spec\.ts$/,
    /e2e\/privacy\/m10-dedup-encrypted\.spec\.ts$/,
  ],
  fullyParallel: false,
  // The harness writes/reads per-level JSON snapshots under
  // `__snapshots__/`; parallel runs would race on those files.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,

  use: {
    baseURL: baseURL ?? "http://localhost:5173",
    trace: "on-first-retry",
    serviceWorkers: "block",
    geolocation: { latitude: 54.6872, longitude: 25.2797 },
    permissions: ["geolocation"],
    launchOptions: {
      args: ["--enable-gpu", "--use-gl=angle", "--use-angle=swiftshader"],
    },
  },

  ...(!baseURL && {
    webServer: {
      command: "pnpm dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      cwd: "../..",
    },
  }),

  projects: [
    {
      name: "validate",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
