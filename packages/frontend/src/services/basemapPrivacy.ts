import { useSyncExternalStore } from "react";
import type { CartoStyleJson } from "../map/styleBuilder.ts";
import {
  basemapProviderForUrl,
  getBasemapProvider,
  type BasemapProviderId,
} from "../config/basemapProviders.ts";
import { canUse, useCanUse } from "../privacy/canUse.ts";

export const DETAILED_BASEMAP_FLOW = "external.detailed-basemap";
/** The provider the detailed map uses today. */
export const DEFAULT_BASEMAP_PROVIDER: BasemapProviderId = "carto";

/** Whether the detailed map may reach `providerId`. The decision is per
 * provider: allowing one never covers another. */
export function isExternalBasemapAllowed(
  providerId: string = DEFAULT_BASEMAP_PROVIDER,
): boolean {
  return canUse(DETAILED_BASEMAP_FLOW, providerId);
}

/** React binding of `isExternalBasemapAllowed`; re-renders on revocation. */
export function useExternalBasemapAllowed(
  providerId: string = DEFAULT_BASEMAP_PROVIDER,
): boolean {
  return useCanUse(DETAILED_BASEMAP_FLOW, providerId);
}

interface FetchBasemapStyleOptions {
  providerId: BasemapProviderId | string;
  dark: boolean;
  signal: AbortSignal;
  /** Override of the decision check, for tests. */
  isAllowed?: (providerId: string) => boolean;
  fetchImpl?: typeof fetch;
}

/** Fetch an external style only while the provider's flow is allowed. The
 * second check closes the async-response race: a style fetched before a
 * revocation is never applied after it. */
export async function fetchBasemapStyle({
  providerId,
  dark,
  signal,
  isAllowed = isExternalBasemapAllowed,
  fetchImpl = fetch,
}: FetchBasemapStyleOptions): Promise<CartoStyleJson | null> {
  const provider = getBasemapProvider(providerId);
  if (!provider || !isAllowed(provider.id)) {
    return null;
  }

  const response = await fetchImpl(
    dark ? provider.darkStyleUrl : provider.lightStyleUrl,
    { signal },
  );
  if (!response.ok) throw new Error(`${provider.id} HTTP ${response.status}`);
  const style = (await response.json()) as CartoStyleJson;

  return isAllowed(provider.id) ? style : null;
}

// ---------------------------------------------------------------------------
// Request guard
// ---------------------------------------------------------------------------

/** An empty vector tile / glyph range: valid protobuf, nothing to draw. */
const EMPTY_PROTOBUF = "data:application/x-protobuf;base64,";
const EMPTY_JSON = "data:application/json,%7B%7D";
/** 1×1 transparent PNG, for raster tiles and sprite sheets. */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function emptyResource(url: string, resourceType: string | undefined): string {
  switch (resourceType) {
    case "SpriteJSON":
    case "Style":
    case "Source":
      return EMPTY_JSON;
    case "SpriteImage":
    case "Image":
      return TRANSPARENT_PNG;
    case "Glyphs":
      return EMPTY_PROTOBUF;
    default:
      return /\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(url)
        ? TRANSPARENT_PNG
        : EMPTY_PROTOBUF;
  }
}

/**
 * Last line of defence for every request the map engine makes (style,
 * tiles, glyphs, sprites, images). Same-origin and inline URLs pass. A
 * cross-origin URL passes only when it belongs to a registered basemap
 * provider whose flow is allowed right now; anything else (a revoked
 * provider, an unregistered fallback host, a source left over from a style
 * swap) is answered locally with an empty resource and never leaves the
 * device. Returns the replacement URL, or `undefined` to let the request
 * through unchanged.
 */
export function guardMapRequest(
  url: string,
  resourceType: string | undefined,
  origin: string,
  isAllowed: (providerId: string) => boolean = isExternalBasemapAllowed,
): string | undefined {
  if (url.startsWith("data:") || url.startsWith("blob:")) return undefined;
  if (url.startsWith(`${origin}/`) || url.startsWith("/")) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return undefined;
  const provider = basemapProviderForUrl(url);
  if (provider && isAllowed(provider.id)) return undefined;
  return emptyResource(url, resourceType);
}

// ---------------------------------------------------------------------------
// Detailed basemap status (for the map's own status line)
// ---------------------------------------------------------------------------

export type DetailedBasemapStatus = "off" | "loading" | "loaded" | "failed";

let detailedStatus: DetailedBasemapStatus = "off";
const statusListeners = new Set<() => void>();

/** Called by the map when its external style starts, lands, fails or goes. */
export function reportDetailedBasemapStatus(status: DetailedBasemapStatus): void {
  if (status === detailedStatus) return;
  detailedStatus = status;
  for (const listener of statusListeners) {
    try {
      listener();
    } catch {
      // One failing subscriber must not stop the others.
    }
  }
}

export function getDetailedBasemapStatus(): DetailedBasemapStatus {
  return detailedStatus;
}

function subscribeDetailedBasemapStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function useDetailedBasemapStatus(): DetailedBasemapStatus {
  return useSyncExternalStore(
    subscribeDetailedBasemapStatus,
    getDetailedBasemapStatus,
    getDetailedBasemapStatus,
  );
}
