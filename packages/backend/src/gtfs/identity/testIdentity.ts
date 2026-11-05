import type { InternTable } from "@pt/shared";
import type { Identity } from "./types.js";

/**
 * Minimal empty Identity for unit tests that construct GtfsIndexes but don't
 * exercise Identity itself. Do NOT use in production code — lookups always
 * fail (indexOf returns -1, valueAt throws).
 */
export function emptyTestIdentity(buildDateIso = "2026-04-20", horizonDays = 90): Identity {
  const empty = {
    size: 0,
    indexOf: () => -1,
    valueAt: () => { throw new RangeError("empty test identity"); },
  };
  return {
    stops: empty,
    routes: empty,
    services: empty,
    headsigns: empty,
    trips: empty,
    bitmasks: new Map(),
    buildDateIso,
    horizonDays,
  };
}

function arrayInternTable(values: readonly string[]): InternTable<string> {
  const idx = new Map<string, number>();
  values.forEach((v, i) => idx.set(v, i));
  return {
    get size() { return values.length; },
    indexOf(v) { return idx.get(v) ?? -1; },
    valueAt(ix) {
      if (ix < 0 || ix >= values.length) throw new RangeError(`valueAt(${ix}) out of range`);
      return values[ix]!;
    },
  };
}

const emptyTable: InternTable<string> = {
  size: 0,
  indexOf: () => -1,
  valueAt: () => { throw new RangeError("empty test identity"); },
};

/** Build a test Identity pre-populated with the given ids per table. */
export function testIdentityWith(opts: {
  stops?: string[];
  routes?: string[];
  trips: string[];
  services: string[];
  headsigns: string[];
}, buildDateIso = "2026-04-20", horizonDays = 90): Identity {
  return {
    stops: opts.stops ? arrayInternTable(opts.stops) : emptyTable,
    routes: opts.routes ? arrayInternTable(opts.routes) : emptyTable,
    trips: arrayInternTable(opts.trips),
    services: arrayInternTable(opts.services),
    headsigns: arrayInternTable(opts.headsigns),
    bitmasks: new Map(),
    buildDateIso,
    horizonDays,
  };
}
