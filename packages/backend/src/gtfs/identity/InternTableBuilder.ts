import type { InternTable } from "@pt/shared";

/**
 * Append-only, cap-enforced intern table builder.
 */
export interface InternTableBuilder<T> extends InternTable<T> {
  /** Intern `value`, returning its ix. Returns existing ix for known value. */
  intern(value: T): number;
  /** Close the builder. Returns a read-only view; further intern calls throw. */
  freeze(): InternTable<T>;
}

export interface InternTableBuilderOptions {
  /** Maximum number of distinct entries. Throws on overflow. */
  cap: number;
  /** Human-readable label used in error/warning messages (e.g. "stops"). */
  label: string;
}

export function createInternTableBuilder<T>(
  opts: InternTableBuilderOptions,
): InternTableBuilder<T> {
  if (opts.cap <= 0) {
    throw new Error(`InternTableBuilder: cap must be positive, got ${opts.cap}`);
  }
  const map = new Map<T, number>();
  const arr: T[] = [];
  let frozen = false;
  let warned = false;

  function maybeWarn(): void {
    if (!warned && arr.length >= Math.floor(opts.cap * 0.8)) {
      console.warn(
        `[GTFS] ${opts.label} intern size ${arr.length} is ≥ 80% of cap ${opts.cap} — ` +
        `consider raising PT_CAP_${opts.label.toUpperCase()}`,
      );
      warned = true;
    }
  }

  function intern(value: T): number {
    if (frozen) {
      throw new Error(`InternTableBuilder(${opts.label}): cannot intern after freeze()`);
    }
    const existing = map.get(value);
    if (existing !== undefined) return existing;
    if (arr.length >= opts.cap) {
      throw new Error(
        `GTFS feed rejected — ${opts.label} intern size would exceed cap ${opts.cap}. ` +
        `Increase PT_CAP_${opts.label.toUpperCase()} if legitimate.`,
      );
    }
    const ix = arr.length;
    arr.push(value);
    map.set(value, ix);
    maybeWarn();
    return ix;
  }

  function indexOf(value: T): number {
    return map.get(value) ?? -1;
  }

  function valueAt(ix: number): T {
    if (!Number.isInteger(ix) || ix < 0 || ix >= arr.length) {
      throw new RangeError(
        `InternTableBuilder(${opts.label}): ix ${ix} out of range (size=${arr.length})`,
      );
    }
    return arr[ix]!;
  }

  return {
    get size(): number { return arr.length; },
    intern,
    indexOf,
    valueAt,
    freeze(): InternTable<T> {
      frozen = true;
      return {
        get size(): number { return arr.length; },
        indexOf,
        valueAt,
      };
    },
  };
}
