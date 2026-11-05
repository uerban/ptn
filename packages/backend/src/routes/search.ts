import type { FastifyRequest, FastifyReply } from "fastify";
import { REMOTE_STOP_SEARCH_MIN_CHARS } from "@pt/shared";
import { adapterRegistryFor } from "../adapters/registry.js";

interface SearchQuery {
  q: string;
  limit?: string;
  adapter?: string;
}

export async function searchStops(
  request: FastifyRequest<{ Querystring: SearchQuery }>,
  reply: FastifyReply
) {
  const { q, limit, adapter } = request.query;

  if (!q || q.length < REMOTE_STOP_SEARCH_MIN_CHARS) {
    return reply.send({ data: [] });
  }

  const parsedLimit = limit?.trim() ? Number(limit) : undefined;
  if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)) {
    return reply.status(400).send({
      error: { code: "INVALID_PARAMS", message: "limit must be an integer between 1 and 100" },
    });
  }

  const registry = adapterRegistryFor(request);
  const routingAdapter =
    (adapter ? registry.get(adapter) : null) ?? registry.getDefault();

  try {
    const start = performance.now();
    const stops = await routingAdapter.searchStops(q, parsedLimit);
    const elapsed = Math.round(performance.now() - start);

    reply.header("Cache-Control", "public, max-age=60");
    return reply.send({
      data: stops,
      meta: { adapter: routingAdapter.name, responseTimeMs: elapsed },
    });
  } catch (err) {
    request.log.error(err, "searchStops failed");
    return reply.status(502).send({
      error: {
        code: "ADAPTER_ERROR",
        message: "Upstream service error",
        details: { adapter: routingAdapter.name },
      },
    });
  }
}
