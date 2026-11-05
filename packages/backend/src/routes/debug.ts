import type { FastifyRequest, FastifyReply } from "fastify";
import type { GtfsStore } from "../gtfs/store.js";

interface DebugQuery {
  threshold?: string;
}

export async function getStopRoutesFilter(
  request: FastifyRequest<{ Querystring: DebugQuery }>,
  reply: FastifyReply,
) {
  const store = (request.server as unknown as { gtfsStore: GtfsStore }).gtfsStore;
  if (!store || !store.isReady()) {
    return reply.status(503).send({
      error: { code: "SERVICE_UNAVAILABLE", message: "GTFS data not ready" },
    });
  }

  const threshold = Math.max(1, parseInt(request.query.threshold ?? "5", 10));
  if (!Number.isFinite(threshold)) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "threshold must be a positive integer" },
    });
  }

  const counts = store.getStopRouteTripCounts();
  const allStops = store.getAllStops();
  const stopNameMap = new Map(allStops.map((s) => [s.id, s.name]));
  const routeMap = new Map(allStops.flatMap((s) => s.routes.map((r) => [r.id, r.shortName])));

  const affected: {
    stopId: string;
    stopName: string;
    routeId: string;
    routeShortName: string;
    tripCount: number;
  }[] = [];

  for (const [stopId, routeCounts] of counts) {
    for (const [routeId, tripCount] of routeCounts) {
      if (tripCount < threshold) {
        affected.push({
          stopId,
          stopName: stopNameMap.get(stopId) ?? stopId,
          routeId,
          routeShortName: routeMap.get(routeId) ?? routeId,
          tripCount,
        });
      }
    }
  }

  affected.sort((a, b) => a.tripCount - b.tripCount);

  const uniqueStops = new Set(affected.map((a) => a.stopId));
  const uniqueRoutes = new Set(affected.map((a) => a.routeId));

  return reply.send({
    threshold,
    summary: {
      affectedPairings: affected.length,
      affectedStops: uniqueStops.size,
      affectedRoutes: uniqueRoutes.size,
      totalStops: counts.size,
      totalPairings: [...counts.values()].reduce((sum, m) => sum + m.size, 0),
    },
    affected,
  });
}
