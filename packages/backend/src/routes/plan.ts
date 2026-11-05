import type { FastifyRequest, FastifyReply } from "fastify";
import type { TripQuery } from "@pt/shared";
import { parseMobilityProfile } from "@pt/shared";

interface PlanQuery {
  fromLat: string;
  fromLon: string;
  toLat: string;
  toLon: string;
  departAt?: string;
  arriveBy?: string;
  adapter?: string;
  maxTransfers?: string;
  cursor?: string;
  mobilityProfile?: string;
}

export async function planRoute(
  request: FastifyRequest<{ Querystring: PlanQuery }>,
  reply: FastifyReply
) {
  const { fromLat, fromLon, toLat, toLon, departAt, arriveBy, adapter, maxTransfers, cursor, mobilityProfile } =
    request.query;

  if (!fromLat?.trim() || !fromLon?.trim() || !toLat?.trim() || !toLon?.trim()) {
    return reply.status(400).send({
      error: {
        code: "MISSING_PARAMS",
        message: "fromLat, fromLon, toLat, toLon are required",
      },
    });
  }

  const parsedFromLat = Number(fromLat);
  const parsedFromLon = Number(fromLon);
  const parsedToLat = Number(toLat);
  const parsedToLon = Number(toLon);
  if (!Number.isFinite(parsedFromLat) || !Number.isFinite(parsedFromLon) || !Number.isFinite(parsedToLat) || !Number.isFinite(parsedToLon)) {
    return reply.status(400).send({
      error: {
        code: "INVALID_PARAMS",
        message: "fromLat, fromLon, toLat, toLon must be valid numbers",
      },
    });
  }
  if (parsedFromLat < -90 || parsedFromLat > 90 || parsedToLat < -90 || parsedToLat > 90) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "Latitude must be between -90 and 90" },
    });
  }
  if (parsedFromLon < -180 || parsedFromLon > 180 || parsedToLon < -180 || parsedToLon > 180) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "Longitude must be between -180 and 180" },
    });
  }

  if (departAt && isNaN(new Date(departAt).getTime())) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "departAt must be a valid date" },
    });
  }
  if (arriveBy && isNaN(new Date(arriveBy).getTime())) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "arriveBy must be a valid date" },
    });
  }

  const parsedMaxTransfers = maxTransfers?.trim() ? Number(maxTransfers) : undefined;
  if (parsedMaxTransfers !== undefined && (!Number.isFinite(parsedMaxTransfers) || !Number.isInteger(parsedMaxTransfers) || parsedMaxTransfers < 0 || parsedMaxTransfers > 10)) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "maxTransfers must be an integer between 0 and 10" },
    });
  }

  const registry = (request.server as any).adapters;
  const routingAdapter =
    (adapter ? registry.get(adapter) : null) ?? registry.getDefault();

  const query: TripQuery = {
    from: { lat: parsedFromLat, lon: parsedFromLon },
    to: { lat: parsedToLat, lon: parsedToLon },
    departAt: departAt ? new Date(departAt).toISOString() : undefined,
    arriveBy: arriveBy ? new Date(arriveBy).toISOString() : undefined,
    maxTransfers: parsedMaxTransfers,
    cursor,
    mobilityProfile: parseMobilityProfile(mobilityProfile),
  };

  try {
    const start = performance.now();
    const result = await routingAdapter.planTrip(query);
    const elapsed = Math.round(performance.now() - start);

    return reply.send({
      data: result,
      meta: { adapter: routingAdapter.name, responseTimeMs: elapsed },
    });
  } catch (err) {
    request.log.error(err, "planTrip failed");
    return reply.status(502).send({
      error: {
        code: "ADAPTER_ERROR",
        message: "Upstream service error",
        details: { adapter: routingAdapter.name },
      },
    });
  }
}
