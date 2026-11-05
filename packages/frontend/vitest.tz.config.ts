import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";
import CrossTzReporter from "./test/crossTzReporter.ts";

// Cross-tz suite: run ONLY the device-tz-sensitive specs under `src/__tz_tests__/`.
// `test:tz` invokes this config once per non-UTC zone (NY + Vilnius); the custom
// reporter emits the `crosstz:` line the CI verify-ran guard greps.
//
// IMPORTANT — `exclude`: the base `vitest.config.ts` lists `src/__tz_tests__/**`
// in `test.exclude` (so it stays OUT of the default UTC `pnpm test`). `mergeConfig`
// CONCATENATES arrays, so neither `exclude: []` nor a restated list can clear that
// entry — it always survives the merge and drops our specs. So we DELETE the base
// `test.exclude` before merging, then set our own (sans the `__tz_tests__` entry)
// so `include` can take effect.
const baseWithoutExclude = {
  ...base,
  test: { ...base.test, exclude: undefined },
};

export default mergeConfig(
  baseWithoutExclude,
  defineConfig({
    test: {
      include: ["src/__tz_tests__/**/*.spec.ts"],
      exclude: ["e2e/**", "node_modules/**", "tests/privacy-harness/**"],
      name: "frontend-crosstz",
      reporters: ["default", new CrossTzReporter()],
    },
  }),
);
