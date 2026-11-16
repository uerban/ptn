import type { LatLon } from "@pt/shared";

/**
 * Decode a Google Encoded Polyline string into an array of LatLon points.
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lon += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }

  return points;
}

/** Encode routed points at the same 1e-5 degree precision as decodePolyline. */
export function encodePolyline(points: LatLon[]): string {
  let lat = 0, lon = 0, encoded = "";
  const component = (delta: number) => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    let result = "";
    while (value >= 0x20) { result += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>>= 5; }
    return result + String.fromCharCode(value + 63);
  };
  for (const point of points) {
    const nextLat = Math.round(point.lat * 1e5), nextLon = Math.round(point.lon * 1e5);
    encoded += component(nextLat - lat) + component(nextLon - lon);
    lat = nextLat; lon = nextLon;
  }
  return encoded;
}
