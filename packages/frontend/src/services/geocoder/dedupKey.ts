import type { GeocoderProviderId } from "@pt/shared";
import type { CoarsenedRequest } from "../coordPrivacy.ts";

export async function dedupKey(
  query: string,
  coarsened: CoarsenedRequest,
  providerId: GeocoderProviderId,
): Promise<string> {
  const payload = JSON.stringify({
    query,
    lat: coarsened.snappedCoord.lat,
    lon: coarsened.snappedCoord.lon,
    gridMeters: coarsened.gridMeters,
    providerId,
  });
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
