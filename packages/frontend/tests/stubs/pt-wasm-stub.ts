// Test stub for the `pt-wasm` package (wasm-pack `pkg-web` artifact).
//
// The POI Phase 2 CI gate (vitest.poi-phase2.config.ts) runs WITHOUT building
// the real wasm artifact — POI Phase 2 never exercises routing. But
// Search.stream.test.tsx renders the real Search.tsx, whose routing path
// dynamic-imports "@pt/wasm" (raptorWasm.ts: `await import("@pt/wasm")`). vite
// resolves that specifier at transform time even though the import is lazy, so
// without the real package (or this stub) the gate fails with
// "Failed to resolve entry for package pt-wasm".
//
// This no-op stub satisfies the members raptorWasm.ts touches — `default`
// (the wasm init fn), `PtRouter` (the router ctor) and the handle's `free`.
// Routing itself is covered by build-and-test, which builds real pt-wasm via
// the setup-pt-wasm-pkg-web action.
export default async function init(): Promise<void> {}

export class PtRouter {
  constructor(_bytes: Uint8Array, _modeStr: string) {}

  // wasm-bindgen generates `free()` on every exported struct, and
  // `raptorWasm.ts` calls it when a handle is swapped or torn down. Without it
  // the teardown throws `raw.free is not a function` as an UNHANDLED rejection
  // — it surfaces in whatever suite happens to be running, not the one that
  // built the router, which makes it read as unrelated flake.
  free(): void {}
}
