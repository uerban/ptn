import type { FastifyRequest, FastifyReply } from "fastify";
import { adapterRegistryFor } from "../adapters/registry.js";

interface AlertsQuery {
  adapter?: string;
}

export async function getAlerts(
  request: FastifyRequest<{ Querystring: AlertsQuery }>,
  reply: FastifyReply
) {
  const { adapter } = request.query;

  const registry = adapterRegistryFor(request);
  const routingAdapter =
    (adapter ? registry.get(adapter) : null) ?? registry.getDefault();

  try {
    const start = performance.now();
    const alerts = await routingAdapter.getAlerts();
    const elapsed = Math.round(performance.now() - start);
    return reply.send({
      data: alerts,
      meta: { adapter: routingAdapter.name, responseTimeMs: elapsed },
    });
  } catch (err) {
    request.log.error(err, "getAlerts failed");
    return reply.status(502).send({
      error: {
        code: "ADAPTER_ERROR",
        message: "Upstream service error",
        details: { adapter: routingAdapter.name },
      },
    });
  }
}
