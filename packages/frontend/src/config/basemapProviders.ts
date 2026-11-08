import type {
  PrivacyDataFlowId,
  PrivacyRequestField,
} from "@pt/shared";

export type BasemapProviderId = "carto";

export interface BasemapProviderConfig {
  readonly id: BasemapProviderId;
  readonly name: string;
  readonly lightStyleUrl: string;
  readonly darkStyleUrl: string;
  readonly policyUrl: string;
  /** Hosts (and their subdomains) the provider's style, tiles, sprites and
   * glyphs are served from. A map request to any other cross-origin host is
   * never attributed to this provider. */
  readonly requestHosts: readonly string[];
  readonly flowId: PrivacyDataFlowId;
  readonly requestFields: readonly PrivacyRequestField[];
}

const CARTO_REQUEST_FIELDS = Object.freeze([
  "tileCoordinates",
] as const satisfies readonly PrivacyRequestField[]);

export const BASEMAP_PROVIDERS: Readonly<
  Record<BasemapProviderId, Readonly<BasemapProviderConfig>>
> = Object.freeze({
  carto: Object.freeze({
    id: "carto",
    name: "CARTO",
    lightStyleUrl:
      "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    darkStyleUrl:
      "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    policyUrl: "https://carto.com/privacy/",
    requestHosts: Object.freeze(["basemaps.cartocdn.com"]),
    flowId: "external.detailed-basemap",
    requestFields: CARTO_REQUEST_FIELDS,
  }),
});

export function getBasemapProvider(
  id: string,
): Readonly<BasemapProviderConfig> | undefined {
  return Object.hasOwn(BASEMAP_PROVIDERS, id)
    ? BASEMAP_PROVIDERS[id as BasemapProviderId]
    : undefined;
}

function hostMatches(host: string, allowed: string): boolean {
  return host === allowed || host.endsWith(`.${allowed}`);
}

/** The provider a map request URL belongs to, if any. */
export function basemapProviderForUrl(
  url: string,
): Readonly<BasemapProviderConfig> | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return Object.values(BASEMAP_PROVIDERS).find((provider) =>
    provider.requestHosts.some((allowed) => hostMatches(host, allowed)),
  );
}
