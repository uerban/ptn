import type { FastifyRequest, FastifyReply } from "fastify";
import type { GtfsStore } from "../gtfs/store.js";

export function createColorConfigHandler(store: GtfsStore) {
  return async function getColorConfig(
    _request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const config = store.getColorConfig();
    if (!config) {
      return reply.status(503).send({ error: "Color config not yet computed" });
    }

    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(config);
  };
}
