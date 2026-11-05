/** Loaded only when a browser has no Worker support. */
import type {WalkWasmModule} from "./walkGraphClient.ts";
export {decompressBrotliBytes} from "./brotliDecode.ts";
let initPromise: Promise<WalkWasmModule> | null = null;

/** Same init contract as addressIndexWasm.ts: await `__wbg_init` first. */
export async function loadWasm(): Promise<WalkWasmModule> {
  initPromise ??= (async () => {
    const mod = (await import("@pt/wasm")) as unknown as WalkWasmModule;
    await mod.default();
    return mod;
  })().catch((err) => {
    initPromise = null; // a transient chunk-fetch failure must not stick
    throw err;
  });
  return initPromise;
}

