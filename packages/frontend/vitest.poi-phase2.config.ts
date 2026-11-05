import { defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import base from "./vitest.config.ts";
import PoiPhase2Reporter from "./test/poiPhase2Reporter.ts";

export default mergeConfig(
  base,
  defineConfig({
    test: { reporters: ["default", new PoiPhase2Reporter()] },
    resolve: {
      alias: {
        // The POI Phase 2 gate runs WITHOUT building the real pt-wasm
        // (wasm-pack) artifact — routing is never exercised by POI tests, but
        // Search.stream.test.tsx renders the real Search.tsx whose routing path
        // dynamic-imports "@pt/wasm" (vite resolves the specifier at transform
        // time even though the import is lazy). Alias it to a no-op stub so this
        // gate stays Rust-free; the full pt-wasm build still runs in
        // build-and-test, which covers raptorWasm/routing.
        "@pt/wasm": fileURLToPath(
          new URL("./tests/stubs/pt-wasm-stub.ts", import.meta.url),
        ),
      },
    },
  }),
);
