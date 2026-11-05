import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // vitest's built-in default is 5000ms. A handful of tests do real
    // max-quality brotli compression over ~1MB buffers (poiCorpus,
    // scheduleTileBrotli) — comfortably under 5s alone, but marginal under
    // turbo's parallel package execution (backend+frontend competing for
    // CPU). Both flaked exactly this way under contention; 15s gives real
    // headroom without long enough to mask an actual hang.
    testTimeout: 15_000,
    // Builds the backend dist once before the fork pool (see the file's comment):
    // the schedule-tile-gen byte-parity test needs `dist`, and building it here
    // rather than in-test keeps the ~13s tsc off the parallel workers.
    globalSetup: ["./vitest.globalSetup.ts"],
    // Default vitest include + the local bench/ directory. The bench files use
    // `describe.runIf(process.env.PT_BENCH === "1")` so they no-op in normal
    // `pnpm test` runs and only execute when the env gate is set.
    include: [
      "**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "bench/**/*.bench.?(c|m)[jt]s?(x)",
    ],
    // Vitest 4 dropped `**/dist/**` from the default exclude. globalSetup
    // builds dist/ (compiled tests included) before collection, so without it
    // every test would also run a second time from its compiled copy.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    env: {
      // Pin to UTC so date arithmetic in GTFS tests is timezone-independent.
      // secsToDate uses setHours(0,0,0,0) (local midnight); with TZ=UTC local
      // midnight equals UTC midnight, which is what the fixture ISO strings assume.
      //
      // NOTE: This applies globally to all backend tests. If you add a test that
      // depends on local-TZ Date behavior (unusual in this codebase), use vi's
      // fake timers or an explicit offset — do not remove this pin.
      TZ: "UTC",
    },
    // pool=forks + --expose-gc lets heap-delta tests call global.gc() before
    // measuring. See src/gtfs/index-builder.test.ts for usage.
    pool: "forks",
    execArgv: ["--expose-gc"],
    coverage: {
      exclude: [
        "src/index.ts",
        "src/adapters/benchmark.ts",
        "src/harness/**",
      ],
    },
  },
});
