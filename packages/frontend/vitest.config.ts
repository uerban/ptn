import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  define: {
    // Build-time constants Vite injects via `define` in vite.config.ts. Vitest
    // does not run that config, so any module that reads them at import time —
    // notably src/buildInfo.ts (`version: __BUILD_VERSION__`) — throws a
    // ReferenceError when pulled into a test's render path. Stamp deterministic
    // test values so those modules load (individual tests may still vi.mock
    // buildInfo for a specific version).
    __BUILD_VERSION__: JSON.stringify("0.0.0-test"),
    __BUILD_COMMIT__: JSON.stringify("test"),
    __BUILD_AT__: JSON.stringify("1970-01-01T00:00:00.000Z"),
  },
  resolve: {
    alias: {
      // `virtual:pwa-register/react` is synthesised by vite-plugin-pwa
      // at build time and doesn't resolve in the vitest pipeline.
      // Aliasing to a stand-in lets components that import it
      // (UpdatePrompt, ForceUpdateButton) be unit-tested with vi.mock
      // overrides.
      "virtual:pwa-register/react": fileURLToPath(
        new URL("./tests/stubs/pwa-register-stub.ts", import.meta.url),
      ),
      // Resolve @pt/shared directly to its TypeScript source so vitest
      // always sees the worktree's latest changes without requiring a
      // dist rebuild. Vitest transpiles TS on the fly via Vite, making
      // this always current.
      "@pt/shared/ptb": fileURLToPath(
        new URL("../shared/src/ptb/index.ts", import.meta.url),
      ),
      "@pt/shared/poi": fileURLToPath(
        new URL("../shared/src/poi/index.ts", import.meta.url),
      ),
      "@pt/shared/address-search": fileURLToPath(
        new URL("../shared/src/addressSearch/index.ts", import.meta.url),
      ),
      "@pt/shared/privacy": fileURLToPath(
        new URL("../shared/src/types/privacy.ts", import.meta.url),
      ),
      "@pt/shared/proto": fileURLToPath(
        new URL("../shared/src/proto/route-update.ts", import.meta.url),
      ),
      "@pt/shared/routing": fileURLToPath(
        new URL("../shared/src/routing/index.ts", import.meta.url),
      ),
      "@pt/shared/schedule-tile": fileURLToPath(
        new URL("../shared/src/types/scheduleTile.ts", import.meta.url),
      ),
      "@pt/shared/route-endpoint": fileURLToPath(
        new URL("../shared/src/types/routeEndpoint.ts", import.meta.url),
      ),
      "@pt/shared/time": fileURLToPath(
        new URL("../shared/src/time/timeDomain.ts", import.meta.url),
      ),
      "@pt/shared/transit": fileURLToPath(
        new URL("../shared/src/transit/index.ts", import.meta.url),
      ),
      "@pt/shared/constants": fileURLToPath(
        new URL("../shared/src/constants/index.ts", import.meta.url),
      ),
      "@pt/shared/raptor": fileURLToPath(
        new URL("../shared/src/raptor/index.ts", import.meta.url),
      ),
      "@pt/shared/transfers": fileURLToPath(
        new URL("../shared/src/transfers/index.ts", import.meta.url),
      ),
      "@pt/shared/util": fileURLToPath(
        new URL("../shared/src/util/index.ts", import.meta.url),
      ),
      "@pt/shared": fileURLToPath(
        new URL("../shared/src/index.ts", import.meta.url),
      ),
      // pt-wasm is a wasm-pack artifact that is not built during vitest
      // runs. The stub satisfies the two members raptorWasm.ts touches
      // (`default` init fn and `PtRouter` ctor); individual tests mock
      // it further via vi.mock("@pt/wasm").
      "@pt/wasm": fileURLToPath(
        new URL("./tests/stubs/pt-wasm-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    // src/__tz_tests__ runs ONLY under the dedicated non-UTC `test:tz` config
    // (vitest.tz.config.ts); excluded from the default UTC run so it neither
    // gets collected here nor trips its own harness's non-UTC guard.
    exclude: ["e2e/**", "node_modules/**", "tests/privacy-harness/**", "src/__tz_tests__/**"],
    // The default 5s testTimeout flakes on Windows when 140+ test files
    // run in parallel — JSDOM, fake-indexeddb, and Web Crypto contend
    // hard enough that tests that finish in <2s in isolation briefly
    // stall well past the default. 30s gives headroom for the contention
    // class without masking real hangs (a true infinite loop or unawaited
    // promise will exceed 30s easily). hookTimeout follows so
    // beforeEach/afterEach setup doesn't fail independently of the test
    // body.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
