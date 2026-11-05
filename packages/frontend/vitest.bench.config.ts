import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Resolve @pt/shared to its TypeScript source (same rationale as
      // vitest.config.ts): vitest transpiles on the fly, so the bench always
      // sees THIS worktree's latest @pt/shared without a dist rebuild. The
      // `@pt/shared` node_modules symlink can point at a sibling worktree
      // whose `dist` predates the pattern-mode work (no `PatternMode` export),
      // which crashes `buildRaptorIndex` at `PatternMode.Off`. Aliasing to
      // source makes the bench self-contained and current.
      "@pt/shared/ptb": fileURLToPath(
        new URL("../shared/src/ptb/index.ts", import.meta.url),
      ),
      "@pt/shared/poi": fileURLToPath(
        new URL("../shared/src/poi/index.ts", import.meta.url),
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
    },
  },
  test: {
    environment: "node",
    include: ["tests/benchmarks/**/*.bench.ts"],
    setupFiles: ["tests/benchmarks/setup.ts"],
    benchmark: {
      outputJson: "tests/benchmarks/.results.json",
    },
  },
});
