/**
 * Doubling-grow Uint32Array. Appends cheap; slice() returns a stable copy
 * sized to current length.
 */
export interface GrowableU32 {
  readonly length: number;
  push(value: number): void;
  valueAt(index: number): number;
  /** Return a new Uint32Array holding the first `length` entries. */
  slice(): Uint32Array;
}

export function createGrowableU32(initialCapacity: number = 16): GrowableU32 {
  if (!Number.isInteger(initialCapacity) || initialCapacity <= 0) {
    throw new Error(`GrowableU32: initialCapacity must be a positive integer, got ${initialCapacity}`);
  }
  let buf = new Uint32Array(initialCapacity);
  let len = 0;

  function push(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFF_FFFF) {
      throw new RangeError(`GrowableU32.push: expected uint32, got ${value}`);
    }
    if (len >= buf.length) {
      const next = new Uint32Array(buf.length * 2);
      next.set(buf);
      buf = next;
    }
    buf[len++] = value;
  }

  function valueAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= len) {
      throw new RangeError(`GrowableU32.valueAt: index ${index} out of range (length=${len})`);
    }
    return buf[index]!;
  }

  function slice(): Uint32Array {
    return buf.slice(0, len);
  }

  return {
    get length(): number { return len; },
    push,
    valueAt,
    slice,
  };
}
