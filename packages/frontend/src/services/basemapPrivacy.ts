import type { CartoStyleJson } from "../map/styleBuilder.ts";
import {
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
