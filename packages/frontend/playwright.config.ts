import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL;
const usePreviewServer = process.env.E2E_PREVIEW === "1";
// The preview port can be moved when 4173 is taken by another checkout.
const previewPort = process.env.E2E_PREVIEW_PORT ?? "4173";
const previewURL = `http://localhost:${previewPort}`;
const managedServerURL = usePreviewServer
  ? previewURL
  : "http://localhost:5173";

/** Specs under e2e/perf/ must only run in the `perf` project — they rely on
 *  Chromium-specific flags (--enable-precise-memory-info) and a stable
 *  measurement baseline. Apply this to every non-perf project so they don't
 *  silently pick up the perf specs under `testDir: ./e2e`. */
const IGNORE_PERF = /e2e\/perf\//;

// Headless Chromium defaults to GPU off, so --enable-gpu is required
// for maplibre's WebGL context. Linux CI pins SwiftShader for deterministic
// software rendering on GPU-less runners; macOS lets ANGLE auto-pick Metal.
//
// Per-project scope (not top-level `use`) — Chromium-only. The previous
// top-level placement leaked these args onto pr-webkit's launcher, which
// rejects `--enable-gpu` ("Unknown option"); WebKit crashed at launch and
// `workers: 1` in CI poisoned chromium tests in the same job.
const CHROMIUM_GL_ARGS =
  process.platform === "linux"
    ? ["--enable-gpu", "--use-gl=angle", "--use-angle=swiftshader"]
    : ["--enable-gpu"];
const CHROMIUM_GL_LAUNCH = { launchOptions: { args: CHROMIUM_GL_ARGS } };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? "github" : "html",
  timeout: 30_000,

  use: {
    baseURL: baseURL ?? managedServerURL,
    trace: "on-first-retry",
    serviceWorkers: "block",
    geolocation: { latitude: 54.6872, longitude: 25.2797 },
    permissions: ["geolocation"],
  },

  ...(!baseURL && {
    webServer: {
      command: usePreviewServer
        ? `pnpm preview --port ${previewPort} --strictPort`
        : "pnpm dev",
      url: managedServerURL,
      reuseExistingServer: !process.env.CI && !usePreviewServer,
      timeout: 30_000,
    },
  }),

  projects: [
    {
      name: "validate",
      use: { ...devices["Desktop Chrome"], ...CHROMIUM_GL_LAUNCH },
      grep: /^(?!.*@offline)/,
      testIgnore: IGNORE_PERF,
    },
    {
      name: "staging",
      use: { ...devices["Desktop Chrome"], ...CHROMIUM_GL_LAUNCH },
      grep: /^(?!.*@mock-api|.*@offline)/,
      testIgnore: IGNORE_PERF,
    },
    {
      name: "offline",
      use: {
        ...devices["Desktop Chrome"],
        ...CHROMIUM_GL_LAUNCH,
        baseURL: previewURL,
        serviceWorkers: "allow",
      },
      testIgnore: IGNORE_PERF,
    },
    {
      name: "perf",
      // --enable-precise-memory-info is scoped here (not global) so it can't
      // silently no-op under a project that later swaps engines.
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--enable-gpu",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-precise-memory-info",
          ],
        },
      },
      testMatch: /e2e\/perf\/.*\.spec\.ts/,
    },
    {
      name: "pr-chromium",
      use: { ...devices["Desktop Chrome"], ...CHROMIUM_GL_LAUNCH },
      testIgnore: IGNORE_PERF,
    },
    // pt-wasm cold-start under real Chrome DevTools Protocol CPU throttle
    // (panel perf #3 — `--js-flags=--predictable` does NOT throttle, only
    // makes V8 deterministic). The throttle itself is applied per-spec via
    // `client.send("Emulation.setCPUThrottlingRate", { rate: 4 })` inside
    // tests tagged `@coldstart`; this project just scopes which specs run.
    {
      name: "pr-chromium-throttled",
      use: { ...devices["Desktop Chrome"], ...CHROMIUM_GL_LAUNCH },
      grep: /@coldstart/,
      testIgnore: IGNORE_PERF,
    },
    {
      name: "pr-webkit",
      // No Chromium GL args — WebKit's pw_run.sh rejects --enable-gpu.
      use: { ...devices["iPhone 14"] },
      testIgnore: IGNORE_PERF,
    },
    {
      name: "full-chromium",
      use: { ...devices["Desktop Chrome"], ...CHROMIUM_GL_LAUNCH },
      testIgnore: IGNORE_PERF,
    },
    {
      name: "full-webkit",
      use: { ...devices["iPhone 14"] },
      testIgnore: IGNORE_PERF,
    },
    {
      name: "full-firefox",
      use: { ...devices["Desktop Firefox"] },
      testIgnore: IGNORE_PERF,
    },
  ],
});
