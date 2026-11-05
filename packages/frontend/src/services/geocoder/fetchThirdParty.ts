const EARTH_LAT_METERS_PER_DEG = 111_320;

const FLOAT_RE = /\d+\.\d+/g;

export class PrecisionLeakError extends Error {
  override readonly name = "PrecisionLeakError";

  constructor(detail: string) {
    super(`Coordinate precision leak detected: ${detail}`);
  }
}

function maxAllowedDecimalPlaces(gridMeters: number): number {
  const gridDeg = gridMeters / EARTH_LAT_METERS_PER_DEG;
  const places = -Math.floor(Math.log10(gridDeg));
  return places + 1;
}

function exceedsPrecision(value: string, maxDecimals: number): boolean {
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const decimals = value.length - dot - 1;
  return decimals > maxDecimals;
}

export function assertNoPrecisionLeak(
  url: string,
  body: string | null,
  gridMeters: number,
): void {
  const maxDec = maxAllowedDecimalPlaces(gridMeters);
  const sources: Array<[string, string]> = [["url", url]];
  if (body) sources.push(["body", body]);

  for (const [label, text] of sources) {
    for (const match of text.matchAll(FLOAT_RE)) {
      const floatStr = match[0]!;
      if (exceedsPrecision(floatStr, maxDec)) {
        throw new PrecisionLeakError(
          `${label} contains float "${floatStr}" with ${floatStr.length - floatStr.indexOf(".") - 1} decimals (max ${maxDec} for ${gridMeters}m grid)`,
        );
      }
    }
  }
}

export function formatCoord(value: number, gridMeters: number): string {
  const decimals = maxAllowedDecimalPlaces(gridMeters);
  return value.toFixed(decimals);
}

export async function fetchThirdPartyGeocoder(
  url: string,
  body: string | null,
  gridMeters: number,
  signal: AbortSignal,
): Promise<Response> {
  assertNoPrecisionLeak(url, body, gridMeters);
  return fetch(url, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    ...(body ? { method: "POST", body } : {}),
  });
}
