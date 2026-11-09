import type { GeocoderProviderId } from "@pt/shared";
import type { CoarsenedRequest } from "../coordPrivacy.ts";
import { getOrCreateHmacKey, isInstallKeyDurable } from "../installKey.ts";

/**
 * Lookup key for the geocoder dedup cache: an HMAC of the query, coarsened
 * coordinate and provider under a non-extractable per-install key. Unlike a
 * plain hash, it cannot be recomputed from a guessed search to confirm that
 * the search was made on this device. Null (no caching) when the key is
 * unavailable or would not survive a reload.
 */
export async function dedupKey(
  query: string,
  coarsened: CoarsenedRequest,
  providerId: GeocoderProviderId,
): Promise<string | null> {
  let key: CryptoKey;
  try {
    key = await getOrCreateHmacKey();
  } catch {
    return null;
  }
  if (!isInstallKeyDurable()) return null;
  const payload = JSON.stringify({
    query,
    lat: coarsened.snappedCoord.lat,
    lon: coarsened.snappedCoord.lon,
    gridMeters: coarsened.gridMeters,
    providerId,
  });
  const encoded = new TextEncoder().encode(payload);
  const mac = await crypto.subtle.sign("HMAC", key, encoded);
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
