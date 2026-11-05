import type { GeocoderProviderId } from "./geocoder.js";

/**
 * A concrete, non-recursive route endpoint.
 *
 * The union is flat by design: RecentRef / SavedRef wrap a BaseEndpoint but
 * are NOT themselves BaseEndpoints. This prevents "recent of recent" /
 * "saved of saved" nesting at the type level.
 */
export type BaseEndpoint =
  | {
      readonly kind: "stop";
      readonly stopId: string;
      readonly name: string;
      readonly lat: number;
      readonly lon: number;
    }
  | {
      readonly kind: "mappoint";
      readonly lat: number;
      readonly lon: number;
      readonly label?: string;
    }
  | {
      readonly kind: "geocoded";
      readonly lat: number;
      readonly lon: number;
      readonly label: string;
      readonly provider: GeocoderProviderId;
      readonly confidence: number;
    }
  | {
      /**
       * A tapped same-name stop group (sibling stops on opposite sides of a
       * street, clustered by `groupByNameCluster`). Carries ALL member stop_ids
       * so routing can board whichever sibling a route variant serves, at
       * walkSecs:0 — see resolveToEntryStops. `lat`/`lon` are the group centroid.
       */
      readonly kind: "stopGroup";
      readonly stopIds: readonly string[];
      readonly lat: number;
      readonly lon: number;
      readonly label: string;
    };

export interface RecentRef {
  readonly kind: "recent";
  readonly base: BaseEndpoint;
  readonly usedAt: number;
  readonly usedAsOrigin: boolean;
}

export interface SavedRef {
  readonly kind: "saved";
  readonly base: BaseEndpoint;
  readonly alias: string;
  readonly savedAt: number;
  readonly encrypted: boolean;
}

export function endpointCoord(ep: BaseEndpoint): { lat: number; lon: number } {
  return { lat: ep.lat, lon: ep.lon };
}
