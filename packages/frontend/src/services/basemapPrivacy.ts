import type { PrivacyPolicy } from "@pt/shared";
import type { CartoStyleJson } from "../map/styleBuilder.ts";
import {
  getBasemapProvider,
  type BasemapProviderId,
} from "../config/basemapProviders.ts";

export function isExternalBasemapAllowed(
  policy: PrivacyPolicy,
  providerId: string,
): boolean {
  return (
    policy.basemapMode === "external-detailed" &&
    getBasemapProvider(providerId) !== undefined
  );
}

interface FetchBasemapStyleOptions {
  providerId: BasemapProviderId | string;
  dark: boolean;
  signal: AbortSignal;
  getPolicy: () => PrivacyPolicy;
  fetchImpl?: typeof fetch;
}

/** Fetch an external style only while both the provider and live policy allow
 * it. The second policy read closes the async-response race: a style fetched
 * before a privacy change is never applied after that change. */
export async function fetchBasemapStyle({
  providerId,
  dark,
  signal,
  getPolicy,
  fetchImpl = fetch,
}: FetchBasemapStyleOptions): Promise<CartoStyleJson | null> {
  const provider = getBasemapProvider(providerId);
  if (!provider || !isExternalBasemapAllowed(getPolicy(), provider.id)) {
    return null;
  }

  const response = await fetchImpl(
    dark ? provider.darkStyleUrl : provider.lightStyleUrl,
    { signal },
  );
  if (!response.ok) throw new Error(`${provider.id} HTTP ${response.status}`);
  const style = (await response.json()) as CartoStyleJson;

  return isExternalBasemapAllowed(getPolicy(), provider.id) ? style : null;
}
