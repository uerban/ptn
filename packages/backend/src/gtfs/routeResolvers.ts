/**
 * Resolver functions threaded through the tile-generation pipeline. The
 * helpers in `buildTileForCell` / `buildBundle` / `buildAndPublishBundle`
 * are pure, but the route's resolved brand color and sub-mode classification
 * live behind the legacy `GtfsStore` private members. Passing resolver
 * callbacks instead of a `GtfsStore` instance keeps the helpers testable
 * without standing up a full store, and the input types each `extend`
 * `RouteResolvers` so the pair is declared once.
 */
export interface RouteResolvers {
  /**
   * Resolve a route's final brand color (hex `#RRGGBB`) — applies the
   * sub-mode override at build time per the PR 1 invariant. Return
   * `undefined` to fall back to the GTFS `route_color` column (with a `#`
   * prepended by `buildTileForCell`).
   */
  resolveRouteColor: (routeId: string) => string | undefined;
  /**
   * Resolve a route's sub-mode classification label (e.g. `"EXPRESS_BUS"`).
   * Return `undefined` for routes without a sub-mode classification.
   */
  resolveRouteSubMode: (routeId: string) => string | undefined;
}
