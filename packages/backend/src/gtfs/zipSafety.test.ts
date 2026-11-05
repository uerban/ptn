import { describe, it, expect } from "vitest";
import { zipSync, strToU8, Zip, ZipPassThrough } from "fflate";
import { assertCompressedSize, safeUnzip, safeStreamingUnzip } from "./zipSafety.js";

const CAPS = {
  zipCompressedBytes: 100_000,
  zipUncompressedBytes: 10_000,
  zipPerEntryBytes: 5000,
  zipMembers: 5,
  zipCompressionRatio: 50,
};

function buildZip(entries: Record<string, string>): Uint8Array {
  const u8Entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) u8Entries[k] = strToU8(v);
  return zipSync(u8Entries, { level: 0 });
}

/**
 * Build a zip with potentially duplicate filenames. fflate's `zipSync` takes a
 * `Record` so it inherently dedupes by name; for the duplicate-rejection tests
 * we need to write two entries with the same filename via the streaming `Zip`
 * writer.
 */
function buildZipWithDuplicates(
  entries: { name: string; content: string }[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip();
  zip.ondata = (err, chunk, _final) => {
    if (err) throw err;
    chunks.push(chunk);
  };
  for (const { name, content } of entries) {
    const passthrough = new ZipPassThrough(name);
    zip.add(passthrough);
    passthrough.push(strToU8(content), true);
  }
  zip.end();
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe("assertCompressedSize", () => {
  it("passes when contentLength under cap", () => {
    expect(() => assertCompressedSize(500, 1000, "http://x")).not.toThrow();
  });

  it("passes when contentLength undefined (server didn't advertise)", () => {
    expect(() => assertCompressedSize(undefined, 1000, "http://x")).not.toThrow();
  });

  it("throws when contentLength exceeds cap", () => {
    expect(() => assertCompressedSize(2000, 1000, "http://x")).toThrow(/compressed|size/i);
  });
});

describe("safeUnzip", () => {
  it("returns entries when all caps respected", () => {
    const zip = buildZip({ "a.txt": "hello", "b.txt": "world" });
    const out = safeUnzip(zip, CAPS);
    expect(Object.keys(out).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("throws on too many members", () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 10; i++) entries[`f${i}.txt`] = "x";
    const zip = buildZip(entries);
    expect(() => safeUnzip(zip, CAPS)).toThrow(/member|entries/i);
  });

  it("throws on per-entry cap overflow", () => {
    const big = "x".repeat(6000);
    const zip = buildZip({ "big.txt": big });
    expect(() => safeUnzip(zip, CAPS)).toThrow(/per-entry|entry size/i);
  });

  it("throws on total uncompressed cap overflow", () => {
    const medium = "x".repeat(4000);
    const entries: Record<string, string> = {};
    for (let i = 0; i < 3; i++) entries[`f${i}.txt`] = medium;
    const zip = buildZip(entries);
    expect(() => safeUnzip(zip, CAPS)).toThrow(/uncompressed|total/i);
  });

  it("throws on compression-ratio blowout", () => {
    const zipped: Uint8Array = zipSync({ "a.txt": strToU8("a".repeat(60_000)) });
    const tightCaps = {
      ...CAPS,
      zipPerEntryBytes: 1_000_000,
      zipUncompressedBytes: 1_000_000,
      zipCompressionRatio: 50,
    };
    expect(() => safeUnzip(zipped, tightCaps)).toThrow(/compression.ratio|ratio/i);
  });

  // Streaming refactor changed the buffered helper from `Record` overwrite to
  // chunk concatenation, which silently merged duplicate members into a single
  // garbage buffer. Reject loudly instead so callers see malformed archives.
  it("rejects duplicate decoded filenames", () => {
    const zip = buildZipWithDuplicates([
      { name: "stops.txt", content: "stop_id,name\ns1,A\n" },
      { name: "stops.txt", content: "stop_id,name\ns2,B\n" },
    ]);
    expect(() => safeUnzip(zip, CAPS)).toThrow(/duplicate entry stops\.txt/i);
  });
});

describe("safeStreamingUnzip", () => {
  it("resolves and delivers all chunks under cap with final=true on last", async () => {
    const stopTimesContent =
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
      "t1,08:00:00,08:00:00,s1,1\n".repeat(500);
    const zip = buildZip({
      "stop_times.txt": stopTimesContent,
      "stops.txt": "stop_id,stop_name\ns1,A\n",
    });
    const roomyCaps = {
      ...CAPS,
      zipPerEntryBytes: 100_000,
      zipUncompressedBytes: 1_000_000,
    };
    const chunks: { name: string; bytes: number; final: boolean }[] = [];
    await safeStreamingUnzip(
      zip,
      roomyCaps,
      (name) => name === "stop_times.txt",
      {
        onFile(name, chunk, final) {
          chunks.push({ name, bytes: chunk.byteLength, final });
        },
      },
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.name === "stop_times.txt")).toBe(true);
    expect(chunks[chunks.length - 1].final).toBe(true);
    const totalBytes = chunks.reduce((a, c) => a + c.bytes, 0);
    expect(totalBytes).toBe(stopTimesContent.length);
  });

  it("rejects when per-file uncompressed exceeds zipPerEntryBytes (stored)", async () => {
    const big = "x".repeat(6000); // > zipPerEntryBytes = 5000
    const zip = buildZip({ "stop_times.txt": big });
    let sawFinal = false;
    await expect(
      safeStreamingUnzip(zip, CAPS, () => true, {
        onFile(_name, _chunk, final) {
          if (final) sawFinal = true;
        },
      }),
    ).rejects.toThrow(/per-entry|entry size/i);
    expect(sawFinal).toBe(false);
  });

  it("rejects high-compression file that decompresses past per-entry cap", async () => {
    // Highly compressible payload (60 000 'a's) compresses to ~80 bytes, but
    // decompresses past zipPerEntryBytes (5000). Catches the zip-bomb pattern
    // where the compressed footprint slips under any compressed-size gate while
    // the inflated bytes blow the per-entry cap — caught chunk-by-chunk in
    // `ondata` before `onFile` ever sees the overflowing chunk.
    const repeating = "a".repeat(60_000);
    const zip = zipSync(
      { "stop_times.txt": strToU8(repeating) },
      { level: 9 },
    );
    expect(zip.byteLength).toBeLessThan(5000); // sanity: compressed payload would slip past any compressed-size gate
    await expect(
      safeStreamingUnzip(zip, CAPS, () => true, {
        onFile() {
          /* swallow */
        },
      }),
    ).rejects.toThrow(/per-entry|entry size|uncompressed/i);
  });

  it("rejects archives with more than zipMembers entries", async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 10; i++) entries[`f${i}.txt`] = "x";
    const zip = buildZip(entries);
    await expect(
      safeStreamingUnzip(zip, CAPS, () => true, {
        onFile() {
          /* swallow */
        },
      }),
    ).rejects.toThrow(/member|entries/i);
  });

  it("rejects on aggregate compression-ratio blowout", async () => {
    const zip = zipSync(
      { "stop_times.txt": strToU8("a".repeat(60_000)) },
      { level: 9 },
    );
    const roomyCaps = {
      ...CAPS,
      zipPerEntryBytes: 1_000_000,
      zipUncompressedBytes: 1_000_000,
      zipCompressionRatio: 50,
    };
    await expect(
      safeStreamingUnzip(zip, roomyCaps, () => true, {
        onFile() {
          /* swallow */
        },
      }),
    ).rejects.toThrow(/compression.ratio|ratio/i);
  });

  it("rejects when zipBuffer exceeds total compressed budget", async () => {
    const tightCaps = { ...CAPS, zipCompressedBytes: 1000 };
    // Two stored 900-byte files → archive easily > 1000 bytes.
    const filler = "y".repeat(900);
    const zip = buildZip({ "a.txt": filler, "b.txt": filler });
    expect(zip.byteLength).toBeGreaterThan(1000);
    await expect(
      safeStreamingUnzip(zip, tightCaps, () => true, {
        onFile() {
          /* swallow */
        },
      }),
    ).rejects.toThrow(/total compressed size .* exceeds cap/i);
  });

  it("rejects duplicate decoded filenames", async () => {
    const zip = buildZipWithDuplicates([
      { name: "stop_times.txt", content: "trip_id,stop_id\nt1,s1\n" },
      { name: "stop_times.txt", content: "trip_id,stop_id\nt2,s2\n" },
    ]);
    await expect(
      safeStreamingUnzip(zip, CAPS, () => true, {
        onFile() {
          /* swallow */
        },
      }),
    ).rejects.toThrow(/duplicate entry stop_times\.txt/i);
  });
});
