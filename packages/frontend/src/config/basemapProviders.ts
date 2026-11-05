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
