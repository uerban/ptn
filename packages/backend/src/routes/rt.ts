import type { FastifyRequest, FastifyReply } from "fastify";
import { encodeRouteUpdate, RT_CACHE_MAX_AGE_S } from "@pt/shared";
import type { GtfsStore } from "../gtfs/store.js";
import type { ProducerRouteRt } from "../gtfs/producerRouteRt.js";

export interface GetRouteRtHandlerDeps {
  /**
   * Producer-mode RT source (the `trip-route.json` artifact grouping). When
   * present (producer mode, wired in `index.ts`), `/api/rt/:routeId` groups RT by
   * route from the artifact with NO `canonical` read; when absent (backend mode,
   * the default), the handler reads `store.getRealtimeForRoute` unchanged.
   */
  producerRouteRt?: ProducerRouteRt;
}

/**
 * Build the `/api/rt/:routeId` handler. The producer-mode RT source (if any) is
 * injected here (in `index.ts`, next to `producerDeparturesSource`) rather than
 * branched on `process.env` inside the handler or read off `store` — keeping the
 * C4-shed seam (`getRealtimeTripUpdates()` + the artifact) out of the canonical
 * `GtfsStore.getRealtimeForRoute` path, which does not survive C4.
 */
export function createGetRouteRtHandler(deps?: GetRouteRtHandlerDeps) {
  const producerRouteRt = deps?.producerRouteRt;

  return async function getRouteRt(
    request: FastifyRequest<{ Params: { routeId: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { routeId } = request.params;

    // Validate routeId format: reject overly long or malformed values
    if (!routeId || routeId.length > 100 || !/^[\w:._-]+$/.test(routeId)) {
      reply.status(400).send({ error: { code: "INVALID_ROUTE_ID", message: "Invalid route ID format" } });
      return;
    }

    const store = (request.server as unknown as { gtfsStore: GtfsStore }).gtfsStore;

    if (!store.isReady()) {
      reply.status(503).send({ error: { code: "LOADING", message: "GTFS data loading" } });
      return;
    }

    // Producer mode: group RT by route via the `trip-route.json` artifact
    // (no `canonical` read). Backend mode: the legacy canonical path.
    const payload = producerRouteRt
      ? encodeRouteUpdate(producerRouteRt.getRouteUpdate(routeId))
      : encodeRouteUpdate({
          routeId,
          trips: store.getRealtimeForRoute(routeId),
          generatedAt: Date.now(),
        });

    reply
      .header("Content-Type", "application/x-protobuf")
      .header("Cache-Control", `public, max-age=${RT_CACHE_MAX_AGE_S}, s-maxage=${RT_CACHE_MAX_AGE_S}`)
      .send(Buffer.from(payload));
  };
}

/**
 * Backend-mode (default) `/api/rt/:routeId` handler — no producer source, reads
 * `store.getRealtimeForRoute` (canonical). Byte-unchanged from before the B4
 * refactor.
 */
export const getRouteRt = createGetRouteRtHandler();
