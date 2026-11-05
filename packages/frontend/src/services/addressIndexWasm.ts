/**
 * Lazy pt-wasm loader for the local address index.
 *
 * Mirrors `raptorWasm.ts`: pt-wasm is built with `wasm-pack --target web`, so
 * the default-exported `__wbg_init` MUST be awaited before any export touches
 * the module — otherwise the first call throws a synchronous TypeError against
 * an `undefined` wasm binding. wasm-bindgen dedupes init, so both this module
 * and the router can call it.
 *
 * Kept separate from `raptorWasm.ts` so address search does not drag the RAPTOR
 * engine's init path in with it: a user who only searches an address never
 * plans a trip, and the two are lazily chunked apart in `vite.config.ts`.
 */

/** The subset of `PtAddressIndex` this app calls. */
export interface PtAddressIndexHandle {
  search(
    query: string,
    limit: number,
  ): {
    label: string;
    lat: number;
    lon: number;
    rowId: number;
    matchedKey: string;
    exact: boolean;
  }[];
  rowCount(): number;
  keyCount(): number;
  fstSizeBytes(): number;
  cityId(): string | undefined;
  free(): void;
}

export class AddressIndexUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`pt-wasm address index unavailable: ${String(cause)}`);
    this.name = "AddressIndexUnavailableError";
  }
}

type AddressWasmModule = {
  PtAddressIndex: new (bytes: Uint8Array) => PtAddressIndexHandle;
  default: (input?: unknown) => Promise<unknown>;
};

let initPromise: Promise<AddressWasmModule> | null = null;

async function loadModule(): Promise<AddressWasmModule> {
  initPromise ??= (async () => {
    const mod = (await import("@pt/wasm")) as AddressWasmModule;
    await mod.default();
    return mod;
  })().catch((err) => {
    // Do not memoize a failure: a transient chunk-fetch error (offline first
    // load, cache miss mid-deploy) must not poison every later search for the
    // lifetime of the tab.
    initPromise = null;
    throw new AddressIndexUnavailableError(err);
  });
  return initPromise;
}

/**
 * Instantiate an index over a packed address artifact (`PTAS`, schema 1).
 *
 * `bytes` is copied into wasm memory; the caller's `ArrayBuffer` is not
 * retained, so the IndexedDB record can be released afterwards.
 */
export async function buildAddressIndex(
  bytes: ArrayBuffer,
): Promise<PtAddressIndexHandle> {
  const mod = await loadModule();
  return new mod.PtAddressIndex(new Uint8Array(bytes));
}

export function __resetAddressIndexWasmForTests(): void {
  initPromise = null;
}
