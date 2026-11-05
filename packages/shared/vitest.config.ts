import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test-setup/tz.ts"],
    // Vitest 4 dropped `**/dist/**` from the default exclude; without it the
    // compiled copies of every test under dist/ run too, against stale output.
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
