import { describe, it, expect } from "vitest";
import { encode, decode, type TransferEdge } from "./wire.js";

const MAGIC = Uint8Array.of(0x50, 0x54, 0x46, 0x54);

function roundTrip(
  stopIds: string[],
  edges: TransferEdge[][],
): ReturnType<typeof decode> {
  return decode(encode(stopIds, edges));
}

describe("transfers wire format — round-trip", () => {
  it("encodes and decodes an empty table", () => {
    const bytes = encode([], []);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x54, 0x46, 0x54]);
    expect(bytes[4]).toBe(1); // version
    expect(bytes[5]).toBe(0); // stopCount = 0
    const out = decode(bytes);
    expect(out.stopIds).toEqual([]);
    expect(Array.from(out.adj.offsets)).toEqual([0]);
    expect(Array.from(out.adj.neighborIx)).toEqual([]);
    expect(Array.from(out.adj.walkSecs)).toEqual([]);
  });

  it("encodes a single stop with no edges", () => {
    const out = roundTrip(["stop-A"], [[]]);
    expect(out.stopIds).toEqual(["stop-A"]);
    expect(Array.from(out.adj.offsets)).toEqual([0, 0]);
    expect(Array.from(out.adj.neighborIx)).toEqual([]);
    expect(Array.from(out.adj.walkSecs)).toEqual([]);
  });

  it("round-trips a small adjacency, sorting edges by walkSecs", () => {
    const ids = ["s0", "s1", "s2", "s3"];
    const edges: TransferEdge[][] = [
      [
        { neighborIdx: 2, walkSecs: 500 }, // intentionally larger first
        { neighborIdx: 1, walkSecs: 120 },
      ],
      [{ neighborIdx: 2, walkSecs: 200 }],
      [],
      [
        { neighborIdx: 0, walkSecs: 60 },
        { neighborIdx: 1, walkSecs: 400 },
      ],
    ];
    const out = roundTrip(ids, edges);
    expect(out.stopIds).toEqual(ids);
    expect(Array.from(out.adj.offsets)).toEqual([0, 2, 3, 3, 5]);
    // s0's edges sorted asc by walkSecs: 120 then 500
    expect(Array.from(out.adj.neighborIx.slice(0, 2))).toEqual([1, 2]);
    expect(Array.from(out.adj.walkSecs.slice(0, 2))).toEqual([120, 500]);
    expect(Array.from(out.adj.neighborIx.slice(2, 3))).toEqual([2]);
    expect(Array.from(out.adj.walkSecs.slice(2, 3))).toEqual([200]);
    expect(Array.from(out.adj.neighborIx.slice(3, 5))).toEqual([0, 1]);
    expect(Array.from(out.adj.walkSecs.slice(3, 5))).toEqual([60, 400]);
  });

  it("preserves unicode stopIds", () => {
    const ids = ["żółć", "🚆-1", "Vilnius/Centras", "плОЩа"];
    const edges: TransferEdge[][] = [[], [], [], []];
    const out = roundTrip(ids, edges);
    expect(out.stopIds).toEqual(ids);
  });

  it("round-trips a large random graph (1000 stops, ~16 edges each)", () => {
    const N = 1000;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push(`stop-${i}`);
    // deterministic pseudo-random
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 0x100000000;
      return seed / 0x100000000;
    };
    const edges: TransferEdge[][] = [];
    for (let i = 0; i < N; i++) {
      const deg = Math.floor(rnd() * 17);
      const seen = new Set<number>();
      const row: TransferEdge[] = [];
      while (row.length < deg) {
        const j = Math.floor(rnd() * N);
        if (j === i || seen.has(j)) continue;
        seen.add(j);
        row.push({ neighborIdx: j, walkSecs: Math.floor(rnd() * 900) });
      }
      edges.push(row);
    }
    const bytes = encode(ids, edges);
    const out = decode(bytes);
    expect(out.stopIds).toEqual(ids);
    expect(out.adj.offsets[N]).toBe(out.adj.neighborIx.length);
    // every neighbor in range, every per-stop slice sorted asc
    for (let i = 0; i < N; i++) {
      const lo = out.adj.offsets[i];
      const hi = out.adj.offsets[i + 1];
      let prev = -1;
      for (let k = lo; k < hi; k++) {
        expect(out.adj.neighborIx[k]).toBeGreaterThanOrEqual(0);
        expect(out.adj.neighborIx[k]).toBeLessThan(N);
        expect(out.adj.neighborIx[k]).not.toBe(i);
        expect(out.adj.walkSecs[k]).toBeGreaterThanOrEqual(prev);
        prev = out.adj.walkSecs[k];
      }
    }
  });

  it("encodes walkSecs values that span varint widths (1-byte, 2-byte, 3-byte)", () => {
    const ids = ["a", "b", "c", "d"];
    const edges: TransferEdge[][] = [
      [
        { neighborIdx: 1, walkSecs: 0 },
        { neighborIdx: 2, walkSecs: 127 }, // last 1-byte
        { neighborIdx: 3, walkSecs: 128 }, // first 2-byte
      ],
      [{ neighborIdx: 0, walkSecs: 16383 }], // last 2-byte
      [{ neighborIdx: 0, walkSecs: 16384 }], // first 3-byte
      [],
    ];
    const out = roundTrip(ids, edges);
    expect(Array.from(out.adj.walkSecs.slice(0, 3))).toEqual([0, 127, 128]);
    expect(out.adj.walkSecs[3]).toBe(16383);
    expect(out.adj.walkSecs[4]).toBe(16384);
  });
});

describe("transfers wire format — encode validation", () => {
  it("rejects mismatched stopIds/edges lengths", () => {
    expect(() => encode(["a", "b"], [[]])).toThrow(/edges.length.*stopIds.length/);
  });

  it("rejects self-edges", () => {
    expect(() =>
      encode(["a", "b"], [[{ neighborIdx: 0, walkSecs: 10 }], []]),
    ).toThrow(/self-edge/);
  });

  it("rejects out-of-range neighborIdx", () => {
    expect(() =>
      encode(["a", "b"], [[{ neighborIdx: 5, walkSecs: 10 }], []]),
    ).toThrow(/out-of-range/);
    expect(() =>
      encode(["a", "b"], [[{ neighborIdx: -1, walkSecs: 10 }], []]),
    ).toThrow(/out-of-range/);
  });

  it("rejects invalid walkSecs", () => {
    expect(() =>
      encode(["a", "b"], [[{ neighborIdx: 1, walkSecs: -1 }], []]),
    ).toThrow(/walkSecs/);
    expect(() =>
      encode(["a", "b"], [[{ neighborIdx: 1, walkSecs: 1.5 }], []]),
    ).toThrow(/walkSecs/);
    expect(() =>
      encode(["a", "b"], [[{ neighborIdx: 1, walkSecs: Infinity }], []]),
    ).toThrow(/walkSecs/);
  });
});

describe("transfers wire format — decode validation", () => {
  it("rejects buffers that are too short for the header", () => {
    expect(() => decode(new Uint8Array(2))).toThrow(/truncated/);
  });

  it("rejects bad magic", () => {
    const bad = new Uint8Array(8);
    bad.set([0x00, 0x01, 0x02, 0x03], 0);
    expect(() => decode(bad)).toThrow(/bad magic/);
  });

  it("rejects legacy PTNT v1 artifacts", () => {
    expect(() => decode(Uint8Array.of(0x50, 0x54, 0x4e, 0x54, 0x01, 0x00))).toThrow(
      /bad magic|PTFT/,
    );
  });

  it.each([0, 2])("rejects unsupported version %i", (v) => {
    const bad = Uint8Array.from([...MAGIC, v, 0x00]);
    expect(() => decode(bad)).toThrow(new RegExp(`unsupported version ${v}`));
  });

  it("rejects truncated buffer mid-stopId", () => {
    const good = encode(["alpha-stop"], [[]]);
    const truncated = good.slice(0, good.length - 5); // drop part of the stopId
    expect(() => decode(truncated)).toThrow(/truncated/);
  });

  it("rejects truncated buffer mid-varint", () => {
    // header + version + a single byte with continuation bit set, then EOF
    const bad = Uint8Array.from([...MAGIC, 0x01, 0x80]);
    expect(() => decode(bad)).toThrow(/truncated/);
  });

  it("rejects trailing bytes", () => {
    const good = encode(["a"], [[]]);
    const trailing = new Uint8Array(good.length + 2);
    trailing.set(good, 0);
    trailing[good.length] = 0xff;
    trailing[good.length + 1] = 0xff;
    expect(() => decode(trailing)).toThrow(/trailing bytes/);
  });

  it("rejects neighborIdx beyond stopCount", () => {
    // Hand-craft a buffer: 1 stop "a" with one edge pointing at idx 5
    const buf = Uint8Array.from([
      ...MAGIC,
      0x01, // version
      0x01, // stopCount = 1
      0x01, 0x61, // idLen=1, "a"
      0x01, // edgeCount=1
      0x05, // neighborIdx=5 (out of range, only 1 stop)
      0x0a, // walkSecs=10
    ]);
    expect(() => decode(buf)).toThrow(/out of range/);
  });

  it("rejects on-wire self-edges defensively", () => {
    const buf = Uint8Array.from([
      ...MAGIC,
      0x01, // version
      0x01, // stopCount = 1
      0x01, 0x61, // idLen=1, "a"
      0x01, // edgeCount=1
      0x00, // neighborIdx=0 (self)
      0x0a,
    ]);
    expect(() => decode(buf)).toThrow(/self-edge/);
  });

  it("rejects varints whose scale would overflow Number.MAX_SAFE_INTEGER", () => {
    // 10 continuation bytes (0x80, with low bits = 0) — each iteration
    // multiplies `scale` by 128. After ~8 bytes the next multiply would
    // push scale past 2^49, which the check rejects before the multiply.
    const bad = Uint8Array.from([
      ...MAGIC,
      0x01,
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
    ]);
    expect(() => decode(bad)).toThrow(/varint overflow/);
  });

  it("rejects invalid UTF-8 in stopIds", () => {
    // 0xC0 0x80 is overlong NUL — invalid UTF-8
    const buf = Uint8Array.from([
      ...MAGIC,
      0x01,
      0x01, // stopCount = 1
      0x02, 0xc0, 0x80, // idLen=2, bad UTF-8
      0x00, // edgeCount=0
    ]);
    expect(() => decode(buf)).toThrow(/UTF-8/);
  });
});
