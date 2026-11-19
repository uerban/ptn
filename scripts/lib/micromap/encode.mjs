// Google Encoded Polyline (precision 5) writer for the micromap artifact.
//
// The frontend already ships a decoder — `packages/frontend/src/utils/
// polyline.ts` — used for GTFS shapes, so encoding micromap geometry the same
// way means no new wire codec on the client. Precision 5 is ~1 m, far finer
// than the artifact needs, but the encoding is delta-based: after
// simplification the deltas are small and each vertex costs only a few bytes,
// and brotli eats the rest.

/** Encode one signed delta with the standard 5-bit chunk scheme. */
function encodeSignedNumber(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

/**
 * Encode `[lon, lat]` GeoJSON pairs into a polyline string. Coordinates are
 * emitted lat-first, matching the decoder.
 */
export function encodePolyline(points) {
  let lastLat = 0;
  let lastLon = 0;
  let out = "";
  for (const [lon, lat] of points) {
    const qLat = Math.round(lat * 1e5);
    const qLon = Math.round(lon * 1e5);
    out += encodeSignedNumber(qLat - lastLat);
    out += encodeSignedNumber(qLon - lastLon);
    lastLat = qLat;
    lastLon = qLon;
  }
  return out;
}

/**
 * Drop vertices that quantize onto the same 1e-5 grid cell as their
 * predecessor. Those cost bytes and encode to a zero delta pair that the
 * decoder faithfully reproduces as a duplicate point.
 */
export function dedupeQuantized(points) {
  const out = [];
  let lastLat = null;
  let lastLon = null;
  for (const [lon, lat] of points) {
    const qLat = Math.round(lat * 1e5);
    const qLon = Math.round(lon * 1e5);
    if (qLat === lastLat && qLon === lastLon) continue;
    out.push([lon, lat]);
    lastLat = qLat;
    lastLon = qLon;
  }
  return out;
}
