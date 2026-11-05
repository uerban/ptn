import type { FastifyRequest, FastifyReply } from "fastify";
import { adapterRegistryFor } from "../adapters/registry.js";

interface NearbyQuery {
  lat: string;
  lon: string;
  radius?: string;
  adapter?: string;
}

export async function getNearby(
  request: FastifyRequest<{ Querystring: NearbyQuery }>,
  reply: FastifyReply
) {
  const { lat, lon, radius, adapter } = request.query;

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
  if (parsedLat < -90 || parsedLat > 90) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "Latitude must be between -90 and 90" },
    });
  }
  if (parsedLon < -180 || parsedLon > 180) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "Longitude must be between -180 and 180" },
    });
  }

  const parsedRadius = radius?.trim() ? Number(radius) : undefined;
  if (parsedRadius !== undefined && (!Number.isFinite(parsedRadius) || !Number.isInteger(parsedRadius) || parsedRadius < 1 || parsedRadius > 50000)) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "radius must be an integer between 1 and 50000" },
    });
  }

  const registry = adapterRegistryFor(request);
  const routingAdapter =
    (adapter ? registry.get(adapter) : null) ?? registry.getDefault();

  try {
    const start = performance.now();
    const stops = await routingAdapter.getNearbyStops(
      { lat: parsedLat, lon: parsedLon },
      parsedRadius
    );
    const elapsed = Math.round(performance.now() - start);

    return reply.send({
      data: stops,
      meta: { adapter: routingAdapter.name, responseTimeMs: elapsed },
    });
  } catch (err) {
    request.log.error(err, "getNearbyStops failed");
    return reply.status(502).send({
      error: {
        code: "ADAPTER_ERROR",
        message: "Upstream service error",
        details: { adapter: routingAdapter.name },
      },
    });
  }
}
