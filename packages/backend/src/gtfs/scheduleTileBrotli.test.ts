import { describe, it, expect } from "vitest";
import { randomFillSync } from "node:crypto";
import { brotliCompressSync, constants } from "node:zlib";
import { compressTileBytes, decompressTileBytes, MAX_COMPRESSED_TILE_BYTES } from "./scheduleTileBrotli.js";
import { metricsRegistry } from "../metrics/registry.js";

async function compressedTileBytesCount(): Promise<number> {
  const json = await metricsRegistry.registry.getMetricsAsJSON();
  const m = json.find((x) => x.name === "pt_compressed_tile_bytes");
  if (!m) return 0;
  return m.values
    .filter((v) => (v as unknown as { metricName?: string }).metricName?.endsWith("_count"))
    .reduce((sum, v) => sum + (v.value ?? 0), 0);
}

describe("scheduleTileBrotli", () => {
  it("round-trips a small JSON-shaped buffer", () => {
    const input = new TextEncoder().encode('{"hello":"world","n":42}');
    const compressed = compressTileBytes(input);
    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(compressed.byteLength).toBeGreaterThan(0);

    const out = decompressTileBytes(compressed);
    expect(new TextDecoder().decode(out)).toBe('{"hello":"world","n":42}');
  });

  it("compresses a large repetitive payload to a much smaller size", () => {
    const repetitive = "x".repeat(100_000);
    const input = new TextEncoder().encode(repetitive);
    const compressed = compressTileBytes(input);
    // Brotli q=11 on highly repetitive data should reach < 1% ratio.
    expect(compressed.byteLength).toBeLessThan(input.byteLength / 50);
  });

  it("produces byte-identical output to brotliCompressSync with the same params", () => {
    // On-disk tiles + bundleHash inputs must be unchanged. Pin both a small
    // payload and a large one against a direct brotliCompressSync call.
    for (const payload of [
      new TextEncoder().encode('{"hello":"world","n":42}'),
      new TextEncoder().encode("x".repeat(100_000)),
    ]) {
      const reference = brotliCompressSync(payload, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        },
      });
      const got = compressTileBytes(payload);
      expect(Buffer.compare(Buffer.from(got), reference)).toBe(0);
    }
  });

  it("returns synchronously (the off-thread-revert guard)", () => {
    // compressTileBytes MUST stay on the main thread (brotliCompressSync). Moving
    // it off-thread (libuv pool OR a worker) spread brotli across extra glibc
    // per-thread malloc arenas that retained the large q=11 buffers — a ~+70 MB
    // steady-RSS regression the memory-gate caught on large-tile cities. A return
    // value that is a Promise (not a Uint8Array) is exactly that revert.
    const got = compressTileBytes(new TextEncoder().encode("guard"));
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got).not.toBeInstanceOf(Promise);
  });

  it("throws when the compressed output exceeds MAX_COMPRESSED_TILE_BYTES", () => {
    // Generate non-compressible data large enough to exceed the cap after
    // compression. Cryptographically random bytes do not compress well;
    // ~2.5 MB input → ~2.5 MB compressed > 2 MiB cap.
    const noisy = new Uint8Array(2_500_000);
    randomFillSync(noisy);
    expect(() => compressTileBytes(noisy)).toThrow(/exceeds MAX_COMPRESSED_TILE_BYTES/i);
  });

  it("MAX_COMPRESSED_TILE_BYTES is the build-time per-tile compressed-byte ceiling", () => {
    expect(MAX_COMPRESSED_TILE_BYTES).toBe(2 * 1024 * 1024);
  });

  it("decompressTileBytes rejects malformed input", () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(() => decompressTileBytes(garbage)).toThrow();
  });

  it("observes pt_compressed_tile_bytes on every compress attempt, including over-cap throws", async () => {
    // The deliberate ordering in compressTileBytes — observe BEFORE the
    // throw — means a future refactor that "cleans up" by moving the
    // observe past the throw would silently drop the worst offenders from
    // p99. Pin both the success and the over-cap paths.
    const before = await compressedTileBytesCount();

    compressTileBytes(new TextEncoder().encode("small payload"));

    const noisy = new Uint8Array(2_500_000);
    randomFillSync(noisy);
    expect(() => compressTileBytes(noisy)).toThrow();

    const after = await compressedTileBytesCount();
    expect(after).toBe(before + 2);
  }, 15_000);

  it("respects an injected cap lower than MAX_COMPRESSED_TILE_BYTES", () => {
    // A small but non-trivially-compressible payload that exceeds a tiny cap.
    const noisy = new Uint8Array(4096);
    randomFillSync(noisy);
    expect(() => compressTileBytes(noisy, 256)).toThrow(/exceeds MAX_COMPRESSED_TILE_BYTES/i);
    // The same payload is fine under the production default.
    expect(() => compressTileBytes(noisy)).not.toThrow();
  });

  it("default cap is unchanged: omitting the cap uses MAX_COMPRESSED_TILE_BYTES", () => {
    const small = new TextEncoder().encode("ok");
    // Byte-identical output whether the default is implicit or explicit.
    const implicit = compressTileBytes(small);
    const explicit = compressTileBytes(small, MAX_COMPRESSED_TILE_BYTES);
    expect(Buffer.compare(Buffer.from(implicit), Buffer.from(explicit))).toBe(0);
  });

  it("record:false skips the per-cell pressure histogram (subdivision trial-compresses stay out)", async () => {
    const small = new TextEncoder().encode("histogram-guard");
    const countObservations = async () => {
      const json = await metricsRegistry.registry.getMetricsAsJSON();
      const m = json.find((x) => x.name === "pt_compressed_tile_bytes");
      // prom-client exposes the histogram `_count` sample under `${name}_count`.
      return (m?.values.find((v) => (v as unknown as { metricName?: string }).metricName === "pt_compressed_tile_bytes_count")?.value as number) ?? 0;
    };
    const before = await countObservations();
    compressTileBytes(small, MAX_COMPRESSED_TILE_BYTES, false); // record:false → no observe
    expect(await countObservations()).toBe(before);
    compressTileBytes(small); // default record:true → observe advances
    expect(await countObservations()).toBe(before + 1);
  });
});
