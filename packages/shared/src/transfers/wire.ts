/**
 * Pedestrian transfer-table wire format ("PTFT" — PT Footpath Transfers).
 *
 * The artifact lists, for each stop, a small set of nearby reachable stops
 * with their pre-computed walking time. It is served alongside the routing
 * bundle so RAPTOR can run a footpath-relaxation step without re-routing
 * pedestrians at query time.
 *
 * On-wire layout (all multi-byte integers are unsigned LEB128 varints):
 *
 *   magic       4 bytes  ASCII "PTFT" (0x50 0x54 0x46 0x54)
 *   version     u8       1
 *   stopCount   varint
 *   repeat stopCount times:
 *     idLen     varint   length of stopId in UTF-8 bytes
 *     stopId    bytes    UTF-8 stopId
 *     edgeCount varint   number of outgoing edges for this stop
 *     repeat edgeCount times:
 *       neighborIdx varint   index into the stop list, 0 <= idx < stopCount,
 *                            and idx != stopIdx (no self-edges)
 *       walkSecs    varint   non-negative seconds
 *
 * Invariants enforced on encode and trusted on decode:
 *  - Per-stop edges are sorted by walkSecs ascending. Useful for the consumer:
 *    it can stop scanning a stop's edges as soon as walkSecs exceeds the
 *    remaining time budget.
 *  - No self-edges (neighborIdx == stopIdx).
 *  - neighborIdx < stopCount.
 *
 * Why varint + indices?
 *  - Stop ids appear once in the dictionary; edges reference them by index,
 *    amortizing the string cost across each stop's adjacency.
 *  - walkSecs has a small dynamic range (typically <= 900) so 1-byte varints
 *    dominate; neighborIdx is also small for clustered local graphs.
 *
 * Why CSR on the decode side?
 *  - The RAPTOR consumer iterates a marked stop's outgoing edges contiguously,
 *    which becomes two Uint32Array slices + an offsets lookup. Cache-friendly,
 *    no per-edge allocation.
 */

const MAGIC = Object.freeze([0x50, 0x54, 0x46, 0x54] as const); // "PTFT"
const VERSION = 1;

/** One outgoing footpath edge from a stop. */
export interface TransferEdge {
  /** Index into the encoder's `stopIds` array. Must differ from the source stop. */
  neighborIdx: number;
  /** Walking time in whole seconds. Non-negative. */
  walkSecs: number;
}

/** CSR-encoded adjacency, parallel to `stopIds`. */
export interface TransferAdjacency {
  /** Flat neighbor indices. Length = total edge count. */
  neighborIx: Uint32Array;
  /** Walking seconds, parallel to `neighborIx`. */
  walkSecs: Uint32Array;
  /**
   * CSR offsets. Length = stopCount + 1. Stop `i`'s outgoing edges live in
   * `[offsets[i], offsets[i+1])` slices of `neighborIx` and `walkSecs`.
   */
  offsets: Uint32Array;
}

/** Result of `decode()`. */
export interface DecodedTransfers {
  stopIds: string[];
  adj: TransferAdjacency;
}

/**
 * Encode a transfer table. `edges[i]` is the outgoing edge list for the stop
 * at `stopIds[i]`. Edges may be passed in any order; the encoder sorts them
 * by `walkSecs` ascending. Throws on invalid input.
 */
export function encode(
  stopIds: readonly string[],
  edges: readonly (readonly TransferEdge[])[],
): Uint8Array {
  if (edges.length !== stopIds.length) {
    throw new Error(
      `transfers.encode: edges.length (${edges.length}) must equal stopIds.length (${stopIds.length})`,
    );
  }

  const chunks: Uint8Array[] = [];
  const textEncoder = new TextEncoder();

  chunks.push(Uint8Array.from(MAGIC));
  chunks.push(Uint8Array.of(VERSION));
  chunks.push(encodeVarint(stopIds.length));

  for (let i = 0; i < stopIds.length; i++) {
    const idBytes = textEncoder.encode(stopIds[i]);
    chunks.push(encodeVarint(idBytes.length));
    chunks.push(idBytes);

    const stopEdges = edges[i];
    for (const e of stopEdges) {
      if (e.neighborIdx === i) {
        throw new Error(`transfers.encode: stop index ${i} has a self-edge`);
      }
      if (
        !Number.isInteger(e.neighborIdx) ||
        e.neighborIdx < 0 ||
        e.neighborIdx >= stopIds.length
      ) {
        throw new Error(
          `transfers.encode: stop index ${i} has out-of-range neighborIdx ${e.neighborIdx}`,
        );
      }
      if (
        !Number.isInteger(e.walkSecs) ||
        e.walkSecs < 0 ||
        !Number.isFinite(e.walkSecs)
      ) {
        throw new Error(
          `transfers.encode: stop index ${i} has invalid walkSecs ${e.walkSecs}`,
        );
      }
    }

    const sorted = [...stopEdges].sort((a, b) => a.walkSecs - b.walkSecs);
    chunks.push(encodeVarint(sorted.length));
    for (const e of sorted) {
      chunks.push(encodeVarint(e.neighborIdx));
      chunks.push(encodeVarint(e.walkSecs));
    }
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Decode a PTFT transfer table. Legacy PTNT v1 artifacts are rejected as bad
 * magic, version mismatch, truncation, malformed varint, invalid neighbor
 * index, or invalid UTF-8 in a stopId.
 */
export function decode(bytes: Uint8Array): DecodedTransfers {
  if (bytes.length < MAGIC.length + 1) {
    throw new Error("transfers.decode: truncated buffer (header)");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new Error("transfers.decode: bad magic (not a PTFT transfers artifact)");
    }
  }

  // `MAGIC` is a frozen 4-tuple so `MAGIC.length` is inferred as the literal
  // `4`; the cursor walks the buffer and must accept arbitrary positions.
  let pos: number = MAGIC.length;
  const version = bytes[pos++];
  if (version !== VERSION) {
    throw new Error(
      `transfers.decode: unsupported version ${version} (expected ${VERSION})`,
    );
  }

  const stopCountRes = readVarint(bytes, pos);
  const stopCount = stopCountRes.value;
  pos = stopCountRes.next;

  // Bound the count against the remaining bytes BEFORE allocating: each stop
  // costs at least 2 bytes (idLen varint + edgeCount varint), so a corrupt
  // huge varint is rejected with the module's typed error instead of first
  // attempting a giant allocation and dying with a raw RangeError.
  if (stopCount > (bytes.length - pos) / 2) {
    throw new Error(
      `transfers.decode: stopCount ${stopCount} impossible for ${bytes.length - pos} payload bytes`,
    );
  }

  const stopIds: string[] = new Array(stopCount);
  const offsets = new Uint32Array(stopCount + 1);

  // Two-pass would let us preallocate edge arrays, but counting requires
  // walking the same varints. One pass into growable arrays then converting
  // is simpler and the bottleneck is bytewise scanning either way.
  const flatNeighbors: number[] = [];
  const flatWalks: number[] = [];

  const textDecoder = new TextDecoder("utf-8", { fatal: true });

  for (let i = 0; i < stopCount; i++) {
    const idLenRes = readVarint(bytes, pos);
    pos = idLenRes.next;
    const idLen = idLenRes.value;
    if (pos + idLen > bytes.length) {
      throw new Error(`transfers.decode: truncated buffer (stopId at index ${i})`);
    }
    try {
      stopIds[i] = textDecoder.decode(bytes.subarray(pos, pos + idLen));
    } catch (err) {
      throw new Error(
        `transfers.decode: invalid UTF-8 in stopId at index ${i}: ${(err as Error).message}`,
      );
    }
    pos += idLen;

    const edgeCountRes = readVarint(bytes, pos);
    pos = edgeCountRes.next;
    const edgeCount = edgeCountRes.value;
    offsets[i + 1] = offsets[i] + edgeCount;

    let prevWalk = -1;
    for (let e = 0; e < edgeCount; e++) {
      const neighborRes = readVarint(bytes, pos);
      pos = neighborRes.next;
      if (neighborRes.value >= stopCount) {
        throw new Error(
          `transfers.decode: neighborIdx ${neighborRes.value} out of range (stopCount=${stopCount})`,
        );
      }
      if (neighborRes.value === i) {
        throw new Error(
          `transfers.decode: stop index ${i} has a self-edge`,
        );
      }
      flatNeighbors.push(neighborRes.value);
      const walkRes = readVarint(bytes, pos);
      pos = walkRes.next;
      // Enforce the per-stop walkSecs-ascending invariant `encode()`
      // guarantees (see the format doc above): the same bytes feed the Rust
      // engine, and a consumer relying on the sorted contract would silently
      // early-exit wrong on an unsorted third-party artifact. Fail closed.
      if (walkRes.value < prevWalk) {
        throw new Error(
          `transfers.decode: walkSecs not ascending at stop index ${i} (${walkRes.value} after ${prevWalk})`,
        );
      }
      prevWalk = walkRes.value;
      flatWalks.push(walkRes.value);
    }
  }

  if (pos !== bytes.length) {
    throw new Error(
      `transfers.decode: trailing bytes (consumed ${pos} of ${bytes.length})`,
    );
  }

  return {
    stopIds,
    adj: {
      neighborIx: Uint32Array.from(flatNeighbors),
      walkSecs: Uint32Array.from(flatWalks),
      offsets,
    },
  };
}

function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    throw new Error(`transfers.encode: cannot varint-encode ${value}`);
  }
  const bytes: number[] = [];
  let v = value;
  // Multiplicative approach so values above 2^31 still decode correctly,
  // up to Number.MAX_SAFE_INTEGER.
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Uint8Array.from(bytes);
}

function readVarint(
  bytes: Uint8Array,
  pos: number,
): { value: number; next: number } {
  let value = 0;
  let scale = 1;
  let p = pos;
  for (;;) {
    if (p >= bytes.length) {
      throw new Error("transfers.decode: truncated buffer (varint)");
    }
    const b = bytes[p++];
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return { value, next: p };
    // Check overflow BEFORE multiplying so the next iteration cannot
    // silently produce a value above Number.MAX_SAFE_INTEGER for crafted
    // input. Well-formed builds never hit this (walkSecs maxes near 900).
    if (scale > Number.MAX_SAFE_INTEGER / 128) {
      throw new Error("transfers.decode: varint overflow");
    }
    scale *= 128;
  }
}
