import type { Reporter, TestModule } from "vitest/node";

/** Sums REAL pass/fail across the whole run and emits ONE deterministic line the
 *  CI verify-ran step greps. N = total tests that ran; M = failures. The line is
 *  derived from task results (not hardcoded), so it cannot read green on a
 *  skipped/zero-run suite. Mirrors the pt-core-engine-regression emitter. */
export default class PoiPhase2Reporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    let ran = 0;
    let failed = 0;
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        const state = testCase.result().state;
        if (state === "passed" || state === "failed") ran += 1;
        if (state === "failed") failed += 1;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`poi-phase2: ${ran} assertions run, ${failed} failures`);
  }
}
