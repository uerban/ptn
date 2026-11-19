import { afterEach, expect, it, vi } from "vitest";
import { decodeBrotliBytes } from "./brotliStream.ts";

afterEach(() => vi.unstubAllGlobals());
function nativeIdentity() {
  vi.stubGlobal("DecompressionStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_format: string) { super(); } });
}
it("accepts a native result exactly at its declared limit", async () => {
  nativeIdentity();
  const fallback = vi.fn();
  expect(Array.from(await decodeBrotliBytes(new Uint8Array([1, 2, 3]).buffer, fallback, 3))).toEqual([1, 2, 3]);
  expect(fallback).not.toHaveBeenCalled();
});
it("stops native output beyond the limit instead of retrying it with wasm", async () => {
  nativeIdentity();
  const fallback = vi.fn();
  await expect(decodeBrotliBytes(new Uint8Array(9).buffer, fallback, 8)).rejects.toThrow(/limit/i);
  expect(fallback).not.toHaveBeenCalled();
});
it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid output limit %s before loading a decoder", async limit => {
  vi.stubGlobal("DecompressionStream", undefined);
  const fallback = vi.fn(async () => ({ decompress: () => new Uint8Array([1]) }));
  await expect(decodeBrotliBytes(new ArrayBuffer(1), fallback, limit)).rejects.toThrow(/limit/i);
  expect(fallback).not.toHaveBeenCalled();
});
it("uses incremental wasm output and frees every result and stream", async () => {
  vi.stubGlobal("DecompressionStream", undefined);
  const freeResult = vi.fn(), freeStream = vi.fn(), calls: number[] = [];
  class BrotliDecStream {
    private index = 0;
    decompress(input: Uint8Array, size: number) {
      calls.push(size);
      return { buf: new Uint8Array(this.index++ === 0 ? [1, 2, 3] : [4]),
        code: this.index === 1 ? 3 : 1, input_offset: input.length, free: freeResult };
    }
    free = freeStream;
  }
  const decompress = vi.fn(() => new Uint8Array([99]));
  const out = await decodeBrotliBytes(new Uint8Array([9]).buffer, async () => ({ decompress, BrotliDecStream }), 4);
  expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  expect(calls).toEqual([5, 2]);
  expect(decompress).not.toHaveBeenCalled();
  expect(freeResult).toHaveBeenCalledTimes(2);
  expect(freeStream).toHaveBeenCalledOnce();
});
it("rejects a wasm overrun after a bounded probe and frees its allocations", async () => {
  vi.stubGlobal("DecompressionStream", undefined);
  const freeResult = vi.fn(), freeStream = vi.fn(), sizes: number[] = [];
  class BrotliDecStream {
    decompress(input: Uint8Array, size: number) {
      sizes.push(size);
      return { buf: new Uint8Array(size), code: 3, input_offset: input.length, free: freeResult };
    }
    free = freeStream;
  }
  const decompress = vi.fn(() => new Uint8Array(1000));
  await expect(decodeBrotliBytes(new ArrayBuffer(1), async () => ({ decompress, BrotliDecStream }), 5)).rejects.toThrow(/limit/i);
  expect(sizes).toEqual([6]);
  expect(decompress).not.toHaveBeenCalled();
  expect(freeResult).toHaveBeenCalledOnce();
  expect(freeStream).toHaveBeenCalledOnce();
});
it("refuses an unbounded-only fallback when a limit was requested", async () => {
  vi.stubGlobal("DecompressionStream", undefined);
  const decompress = vi.fn(() => new Uint8Array([1]));
  await expect(decodeBrotliBytes(new ArrayBuffer(1), async () => ({ decompress }), 4)).rejects.toThrow(/bounded/i);
  expect(decompress).not.toHaveBeenCalled();
});
