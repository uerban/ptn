import type { Reporter, TestModule } from "vitest/node";

/** Sums REAL pass/fail across the whole cross-tz run and emits ONE deterministic
 *  line the CI verify-ran step greps. N = total tests that ran; M = failures;
 *  `harness-nonutc` is true iff the named non-UTC-guard test PASSED — so a
 *  zero-collect `include` typo (which drops the guard) reads `harness-nonutc=false`
 *  and fails the gate instead of passing vacuously. `tz=<process.TZ>` records
 *  which zone this invocation ran under (CI runs the suite once per zone).
 *  The line is derived from task results (not hardcoded), so it cannot read green
 *  on a skipped/zero-run suite. Mirrors `poiPhase2Reporter`. */
const HARNESS_NAME = "harness runs under a non-UTC zone";

export default class CrossTzReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    let ran = 0;
    let failed = 0;
    let harnessPassed = false;
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        const state = testCase.result().state;
        if (state === "passed" || state === "failed") ran += 1;
        if (state === "failed") failed += 1;
        if (state === "passed" && testCase.name.includes(HARNESS_NAME)) harnessPassed = true;
      }
    }
    const tz = process.env.TZ ?? "";
    // eslint-disable-next-line no-console
    console.log(
      `crosstz: ${ran} tests run, ${failed} failures, harness-nonutc=${harnessPassed} tz=${tz}`,
    );
  }
}
