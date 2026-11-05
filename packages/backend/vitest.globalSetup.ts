import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Build the backend dist ONCE, before the test fork pool spawns.
//
// The schedule-tile-gen byte-parity test (`scripts/__tests__/schedule-tile-gen.test.ts`)
// runs the SHIPPED producer script `scripts/schedule-tile-gen.mjs` as a subprocess,
// and that script imports the backend from `../dist`. turbo's `test` task only
// builds DEPENDENCY packages (`dependsOn: ["^build"]`), not the backend's own
// dist, so a fresh checkout / CI has none.
//
// Building it here (a vitest globalSetup runs once in the MAIN process, before any
// test fork starts) instead of in that test's `beforeAll` is deliberate: the ~13s
// `tsc` must NOT run concurrently with the parallel `pool: "forks"` workers, or it
// steals CPU from CPU-bound perf-budget tests (e.g. `labelAnchors.test.ts`'s
// 60k-stop `< 3000ms` smoke bound) and flakes them. Here it completes before any
// test runs. Skipped when dist already exists (local dev — no rebuild, no cost).
export default function setup(): void {
  const backendDir = fileURLToPath(new URL(".", import.meta.url));
  if (!existsSync(join(backendDir, "dist", "gtfs", "buildBundle.js"))) {
    execSync("pnpm run build", { cwd: backendDir, stdio: "inherit" });
  }
}
