/**
 * PTB bytes for the e2e mock harness's catalog.
 *
 * The browser gets its catalog as PTB bytes from `/api/<city>/raptor-bundle`,
 * paired with the generation provenance on `/api/<city>/ready`. The specs
 * assert on the topology in `raptor-data.json` (`Šeškinės poliklinika`, route
 * `1`, `test-X`, and the rest), so `catalog.ptb` is the Rust producer's build
 * of that topology: `catalog-gtfs.mjs` writes it as a GTFS feed and
 * `regen-catalog-ptb.sh` runs the producer. `catalog-shapeless.ptb` is the
 * same feed without shape ids, which is what a city without shapes.txt
 * produces.
 *
 * WHY RE-ANCHOR. A PTB v1 service-bitmask window is fixed from the header's
 * feed start date. The feed runs every day, so moving that date to the day the
 * harness runs keeps every departure-listing spec in service without
 * regenerating the bytes. Only the header's feed start date and UTC offset
 * change. A v2 bundle is used as built; see `anchorCatalogPtb`.
 */

import { readFileSync } from "node:fs";

export type CatalogShapes = "advertised" | "absent";

const FILE_BY_SHAPES: Record<CatalogShapes, string> = {
  advertised: "catalog.ptb",
  absent: "catalog-shapeless.ptb",
};

/** The committed producer-built catalog bytes. Node only. */
export function catalogPtbBytes(shapes: CatalogShapes = "advertised"): Uint8Array {
  return readFileSync(new URL(`./${FILE_BY_SHAPES[shapes]}`, import.meta.url));
}

/** `YYYYMMDD` for `date` as seen in `timeZone`. */
function civilDate(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return Number(parts.replaceAll("-", ""));
}

/** UTC offset in seconds for `date` in `timeZone` (PTB header field). */
function tzOffsetSeconds(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(
    dtf.formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - date.getTime()) / 1000);
}

export interface AnchorCatalogPtbOptions {
  /** Defaults to `new Date()` — the reason the service window never rots. */
  now?: Date;
  /** IANA zone the fixture city lives in. */
  timeZone?: string;
}

/**
 * Copy `bytes` with the header's feed start date (`[20..24]`, `YYYYMMDD`) set
 * to `now`'s civil date and its UTC offset (`[28..32]`) to `now`'s offset in
 * `timeZone`.
 */
export function anchorCatalogPtb(
  bytes: Uint8Array,
  options: AnchorCatalogPtbOptions = {},
): Uint8Array {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Europe/Vilnius";
  const out = Uint8Array.from(bytes);
  // A PTB v2 bundle carries its service-day origins as absolute instants, so
  // its header's feed start cannot move without breaking the date mapping.
  // The v2 catalog is used as built: its 400-day window covers the e2e clocks.
  if (new DataView(out.buffer, out.byteOffset, out.byteLength).getUint16(4, true) === 2) {
    return out;
  }
  const header = new DataView(out.buffer, out.byteOffset, out.byteLength);
  header.setUint32(20, civilDate(now, timeZone), true);
  header.setInt32(28, tzOffsetSeconds(now, timeZone), true);
  return out;
}

/** The committed catalog, re-anchored to `now`. Node only. */
export function buildCatalogPtb(
  options: AnchorCatalogPtbOptions & { shapes?: CatalogShapes } = {},
): Uint8Array {
  return anchorCatalogPtb(catalogPtbBytes(options.shapes), options);
}
