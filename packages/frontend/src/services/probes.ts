/**
 * Capability probes, injectable so privacy/failure tests can simulate a no-wasm device in jsdom
 * (which always has a WebAssembly global). The real read is a fast-path: a
 * CSP-blocked-but-present wasm still throws later and is classified as import/init, not no-wasm
 * (panel N2).
 */
let override: boolean | null = null;

export function wasmSupported(): boolean {
  if (override !== null) return override;
  return (
    typeof WebAssembly !== "undefined" &&
    typeof WebAssembly.instantiate === "function"
  );
}

/** Test-only seam. Pass `null` to restore the real probe. */
export function __setWasmSupportedForTests(value: boolean | null): void {
  override = value;
}
