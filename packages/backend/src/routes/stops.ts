import type { FastifyRequest, FastifyReply } from "fastify";

interface StopsNearbyQuery {
  lat: string;
  lon: string;
  radius?: string;
}

export async function getStopsNearby(
  request: FastifyRequest<{ Querystring: StopsNearbyQuery }>,
  reply: FastifyReply
) {
  const { lat, lon, radius } = request.query;

  if (!lat?.trim() || !lon?.trim()) {
    return reply.status(400).send({
      error: { code: "MISSING_PARAMS", message: "lat and lon are required" },
    });
  }

  const parsedLat = Number(lat);
  const parsedLon = Number(lon);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "lat and lon must be valid numbers" },
    });
  }

  const parsedRadius = radius?.trim() ? Number(radius) : 1000;
  if (!Number.isFinite(parsedRadius) || parsedRadius <= 0) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "radius must be a positive number" },
    });
  }

  const store = (request.server as any).gtfsStore;
  if (!store || !store.isReady()) {
    return reply.status(503).send({
      error: { code: "SERVICE_UNAVAILABLE", message: "GTFS data not ready" },
    });
  }

  const stops = store.getNearbyStops(parsedLat, parsedLon, parsedRadius);
  reply.header("Cache-Control", "public, max-age=300");
  return reply.send({ data: stops });
}

interface StopsAllQuery {
  withinHours?: string;
}

export async function getStopsAll(
  request: FastifyRequest<{ Querystring: StopsAllQuery }>,
  reply: FastifyReply
) {
  const store = (request.server as any).gtfsStore;
  if (!store || !store.isReady()) {
    return reply.status(503).send({
      error: { code: "SERVICE_UNAVAILABLE", message: "GTFS data not ready" },
    });
  }

  const { withinHours } = request.query;
  const parsedWithinHours = withinHours?.trim() ? Number(withinHours) : undefined;
  if (parsedWithinHours !== undefined && (!Number.isFinite(parsedWithinHours) || parsedWithinHours < 1 || parsedWithinHours > 48)) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "withinHours must be between 1 and 48" },
    });
  }

  const stops = store.getAllStops();

  if (parsedWithinHours !== undefined) {
    const activeRoutes = store.getActiveRoutesByStop(new Date(), parsedWithinHours);
    const filtered = stops
      .map((stop: { id: string; routes: { id: string }[] }) => {
        const activeSet = activeRoutes.get(stop.id);
        return {
          ...stop,
          routes: activeSet
            ? stop.routes.filter((r) => activeSet.has(r.id))
            : [],
        };
      })
      .filter((stop: { routes: { id: string }[] }) => stop.routes.length > 0);
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send({ data: filtered, lastUpdated: store.getLastUpdated() });
  }

  reply.header("Cache-Control", "public, max-age=300");
  return reply.send({ data: stops, lastUpdated: store.getLastUpdated() });
}
