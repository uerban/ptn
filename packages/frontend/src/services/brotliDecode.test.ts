import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { warmupBrotli } from "./brotliDecode.ts";

// brotli-dec-wasm@2.3.2's MAIN entry exports ONLY a `default` that is a Promise
// resolving to the namespace carrying `decompress` (see its index.d.ts:
// `declare const _default: Promise<typeof brotliDecWasm>; export default _default`).
// There is NO top-level named `decompress` export. The pre-fix consumer did
// `const { decompress } = await import("brotli-dec-wasm")`, so `decompress` was
// `undefined` and calling it threw "decompress is not a function" — which broke
// ALL POI decompression in real browsers (DecompressionStream("br") is universally
// unsupported, so the wasm fallback is the only decode path). This test mocks the
// package with its ACCURATE shape so the consumer's usage is pinned.
const { decompressSpy } = vi.hoisted(() => ({
  decompressSpy: vi.fn((bytes: Uint8Array) => new TextEncoder().encode(`DECODED:${bytes.length}`)),
}));
vi.mock("brotli-dec-wasm", () => ({
  default: Promise.resolve({ decompress: decompressSpy }),
}));

describe("decompressBrotli (brotli-dec-wasm main-entry usage)", () => {
  beforeEach(() => {
    vi.resetModules();
    decompressSpy.mockClear();
    // Force the wasm fallback: skip the native DecompressionStream("br") path
    // (unsupported in all current browsers anyway), so the brotli-dec-wasm path runs.
    vi.stubGlobal("DecompressionStream", undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("awaits the default Promise and calls the resolved namespace's decompress", async () => {
    const { decompressBrotli } = await import("./brotliDecode.ts");
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;

    const out = await decompressBrotli(buffer);

    // The consumer MUST resolve the default Promise and call namespace.decompress
    // (the pre-fix top-level `{ decompress }` destructure yields undefined → throws).
    expect(decompressSpy).toHaveBeenCalledTimes(1);
    expect(decompressSpy.mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
    expect(out).toBe("DECODED:4");
  });
});

describe("warmupBrotli", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("no-ops when native DecompressionStream('br') is constructible", async () => {
    vi.stubGlobal("DecompressionStream", class { constructor(_f: string) {} });
    await expect(warmupBrotli()).resolves.toBeUndefined();
  });
  it("resolves via the wasm fallback when native is unavailable", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    await expect(warmupBrotli()).resolves.toBeUndefined(); // mocked default Promise resolves
  });
});

describe("decompressBrotliBytes", () => {
  beforeEach(() => {
    vi.resetModules();
    decompressSpy.mockClear();
    vi.stubGlobal("DecompressionStream", undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns the decoded bytes, not text", async () => {
    const { decompressBrotliBytes } = await import("./brotliDecode.ts");
    const out = await decompressBrotliBytes(new Uint8Array([9, 9]).buffer);
    // Realm-neutral check: the mock's TextEncoder (node) and the jsdom
    // global hand out Uint8Arrays from different realms, so toBeInstanceOf fails.
    expect(Object.prototype.toString.call(out)).toBe("[object Uint8Array]");
    expect(new TextDecoder().decode(out)).toBe("DECODED:2");
  });
});

describe("decompressBrotliBytes native path", () => {
  beforeEach(() => {
    vi.resetModules();
    decompressSpy.mockClear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Identity "decoder" that records which format names it was asked for. */
  function stubNative(accepts: string[], tried: string[]): void {
    vi.stubGlobal("DecompressionStream", class extends TransformStream<Uint8Array, Uint8Array> {
      constructor(format: string) {
        tried.push(format);
        if (!accepts.includes(format)) throw new TypeError(`unsupported ${format}`);
        super();
      }
    });
  }

  it("asks for the standard 'brotli' format first", async () => {
    const tried: string[] = [];
    stubNative(["brotli", "br"], tried);
    const { decompressBrotliBytes } = await import("./brotliDecode.ts");
    const out = await decompressBrotliBytes(new Uint8Array([7, 8, 9]).buffer);
    expect(tried).toEqual(["brotli"]);
    expect(Array.from(out)).toEqual([7, 8, 9]);
    expect(decompressSpy).not.toHaveBeenCalled();
  });

  it("falls back to the legacy 'br' name", async () => {
    const tried: string[] = [];
    stubNative(["br"], tried);
    const { decompressBrotliBytes } = await import("./brotliDecode.ts");
    const out = await decompressBrotliBytes(new Uint8Array([1]).buffer);
    expect(tried).toEqual(["brotli", "br"]);
    expect(Array.from(out)).toEqual([1]);
  });

  it("a stream that rejects the bytes falls back to the wasm decoder without an unhandled rejection", async () => {
    vi.stubGlobal("DecompressionStream", class {
      readonly readable = new ReadableStream({ start(c) { c.error(new Error("corrupt")); } });
      readonly writable = new WritableStream({ write() { throw new Error("corrupt"); } });
    });
    const { decompressBrotliBytes } = await import("./brotliDecode.ts");
    const out = await decompressBrotliBytes(new Uint8Array([5, 5, 5]).buffer);
    // Let any stray rejection from the voided writer calls surface.
    await new Promise((r) => setTimeout(r, 0));
    expect(new TextDecoder().decode(out)).toBe("DECODED:3");
  });

  it("uses an injected wasm decoder (worker builds cannot dynamic-import)", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    const { decompressBrotliBytes } = await import("./brotliDecode.ts");
    const decompress = vi.fn(() => new Uint8Array([42]));
    const out = await decompressBrotliBytes(new Uint8Array([1, 2]).buffer, async () => ({ decompress }));
    expect(Array.from(out)).toEqual([42]);
    expect(decompressSpy).not.toHaveBeenCalled();
  });
});
