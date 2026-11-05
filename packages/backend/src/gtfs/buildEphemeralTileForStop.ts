import type { DecodedScheduleTile } from "@pt/shared";
import { TILE_EDGE_METERS } from "@pt/shared";
import type { CanonicalStore } from "./canonical/CanonicalStore.js";
import { buildTileForCell } from "./buildTileForCell.js";
import type { RouteResolvers } from "./routeResolvers.js";

export interface BuildEphemeralTileInput extends RouteResolvers {
  canonical: CanonicalStore;
  stopId: string;
}

// Sentinel marker for `bundleHash` / `cityId`. Real bundle hashes are 64 hex
// chars and real city ids are slugs. Distinct values here so logs and any
// future hex check on the cross-tile RT scoping path distinguish ephemeral
// tiles from real ones (no in-process consumer asserts hex on the value
// today — keep the marker so a future check has a tripwire to grab onto).
const EPHEMERAL_BUNDLE_HASH = "ephemeral";

/**
 * Build an in-memory `DecodedScheduleTile` for a single stop without touching
 * disk. Used by the legacy `getDepartures` shim to keep the call path
 * in-process while reusing the tile/`getDeparturesFromTile` pipeline.
 */
export function buildEphemeralTileForStop(
  input: BuildEphemeralTileInput,
): DecodedScheduleTile | null {
  const stop = input.canonical.getStop(input.stopId);
  if (!stop) return null;
  return buildTileForCell({
    canonical: input.canonical,
    cellStops: [stop],
    bundleHash: EPHEMERAL_BUNDLE_HASH,
    cityId: "ephemeral",
    tileSize: TILE_EDGE_METERS,
    resolveRouteColor: input.resolveRouteColor,
    resolveRouteSubMode: input.resolveRouteSubMode,
  });
}
