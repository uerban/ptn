/**
 * Central cap configuration for GTFS ingest safety limits.
 * All caps readable from env; defaults chosen to comfortably pass Paris IDFM
 * while rejecting malicious or malformed feeds.
 */

export interface Caps {
  /** Maximum number of unique trip_ids interned. Default 2,000,000. */
  trips: number;
  /** Maximum number of stops parsed. Default 500,000. */
  stops: number;
  /** Maximum number of routes parsed. Default 50,000. */
  routes: number;
  /** Maximum number of calendar rows parsed. Default 100,000. */
  services: number;
  /** Maximum number of calendar_dates rows parsed. Default 1,000,000. */
  calendarDates: number;
  /** Max compressed zip size (pre-inflate; checked against Content-Length). Default 1 GiB. */
  zipCompressedBytes: number;
  /** Max total uncompressed bytes across the archive. Default 2 GiB. */
  zipUncompressedBytes: number;
  /** Max uncompressed bytes for any single entry. Default 1.5 GiB. */
  zipPerEntryBytes: number;
  /** Max entries in the archive. Default 1000. */
  zipMembers: number;
  /** Max per-entry compression ratio (uncompressed/compressed). Default 100x. */
  zipCompressionRatio: number;
  /** Maximum number of unique shape_ids ingested. Default 50,000. */
  shapesCount: number;
  /** Maximum points per shape. Over-cap shapes are dropped (not truncated). Default 10,000. */
  pointsPerShape: number;
  /** Maximum total encoded-polyline bytes across the emitted shapes artifact. Default 4 MiB. */
  shapesEncodedBytes: number;
}

const DEFAULTS: Caps = {
  trips: 2_000_000,
  stops: 500_000,
  routes: 50_000,
  services: 100_000,
  calendarDates: 1_000_000,
  zipCompressedBytes: 1_073_741_824,
  zipUncompressedBytes: 2_147_483_648,
  zipPerEntryBytes: 1_610_612_736,
  zipMembers: 1000,
  zipCompressionRatio: 100,
  shapesCount: 50_000,
  pointsPerShape: 10_000,
  shapesEncodedBytes: 4 * 1024 * 1024,
};

function readEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function readCaps(): Caps {
  return {
    trips: readEnvNumber("PT_CAP_TRIPS", DEFAULTS.trips),
    stops: readEnvNumber("PT_CAP_STOPS", DEFAULTS.stops),
    routes: readEnvNumber("PT_CAP_ROUTES", DEFAULTS.routes),
    services: readEnvNumber("PT_CAP_SERVICES", DEFAULTS.services),
    calendarDates: readEnvNumber("PT_CAP_CALENDAR_DATES", DEFAULTS.calendarDates),
    zipCompressedBytes: readEnvNumber("PT_CAP_ZIP_COMPRESSED_BYTES", DEFAULTS.zipCompressedBytes),
    zipUncompressedBytes: readEnvNumber("PT_CAP_ZIP_UNCOMPRESSED_BYTES", DEFAULTS.zipUncompressedBytes),
    zipPerEntryBytes: readEnvNumber("PT_CAP_ZIP_PER_ENTRY_BYTES", DEFAULTS.zipPerEntryBytes),
    zipMembers: readEnvNumber("PT_CAP_ZIP_MEMBERS", DEFAULTS.zipMembers),
    zipCompressionRatio: readEnvNumber("PT_CAP_ZIP_COMPRESSION_RATIO", DEFAULTS.zipCompressionRatio),
    shapesCount: readEnvNumber("PT_CAP_SHAPES", DEFAULTS.shapesCount),
    pointsPerShape: readEnvNumber("PT_CAP_POINTS_PER_SHAPE", DEFAULTS.pointsPerShape),
    shapesEncodedBytes: readEnvNumber("PT_CAP_SHAPES_ENCODED_BYTES", DEFAULTS.shapesEncodedBytes),
  };
}
