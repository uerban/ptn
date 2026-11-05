/**
 * Append-only group-terminating CSR (Compressed Sparse Row) builder.
 * Values are concatenated into a single array; offsets[i..i+1] delimits
 * the values of group i. offsets.length === groupCount + 1.
 *
 * Call sequence: push(v)*; endGroup(); push(v)*; endGroup(); ...; finalize().
 * Empty groups (no pushes between endGroup calls) are supported.
 */
export interface Csr<V> {
  readonly groupCount: number;
  /** Flat concatenation of all group values. Length = offsets[groupCount]. */
  readonly values: readonly V[];
  /** Group boundaries. Length = groupCount + 1. offsets[0] === 0. */
  readonly offsets: Uint32Array;
  /** Read group i as a new array. Throws on out-of-range. */
  groupAt(i: number): V[];
}

export interface CsrBuilder<V> {
  push(value: V): void;
  endGroup(): void;
  finalize(): Csr<V>;
}

export function createCsrBuilder<V>(): CsrBuilder<V> {
  const values: V[] = [];
  const offsets: number[] = [0];

  return {
    push(value: V): void {
      values.push(value);
    },
    endGroup(): void {
      offsets.push(values.length);
    },
    finalize(): Csr<V> {
      const offsetsTyped = new Uint32Array(offsets);
      const groupCount = offsets.length - 1;
      return {
        groupCount,
        values,
        offsets: offsetsTyped,
        groupAt(i: number): V[] {
          if (!Number.isInteger(i) || i < 0 || i >= groupCount) {
            throw new RangeError(`Csr.groupAt: group ${i} out of range (groupCount=${groupCount})`);
          }
          const start = offsetsTyped[i]!;
          const end = offsetsTyped[i + 1]!;
          return values.slice(start, end);
        },
      };
    },
  };
}
