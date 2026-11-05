import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { GtfsStore } from "../gtfs/store.js";

/**
 * Shapes artifact is served under a content-addressed path. The public URL
 * (emitted in the manifest and requested by the frontend) includes the city:
 * `/api/vilnius/gtfs/shapes/shapes-<sha256>.json`. By the time the request
 * reaches this handler it has already been stripped of the `/api/<city>/`
 * prefix by the edge proxy (nginx in prod, vite dev proxy locally) and
 * arrives as `/api/gtfs/shapes/shapes-<sha256>.json`, matching the backend's
 * other content-addressed artifact routes. The hash is embedded in the
 * filename so the artifact can be cached immutably for a long time; any feed
 * refresh that changes the shapes produces a new hash and therefore a new URL.
 */
const ARTIFACT_PATTERN = /^shapes-([0-9a-f]+)\.json$/;

export async function registerShapesRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { artifact: string } }>(
    "/api/gtfs/shapes/:artifact",
    async (
      req: FastifyRequest<{ Params: { artifact: string } }>,
      reply: FastifyReply,
    ) => {
      const store = (req.server as unknown as { gtfsStore: GtfsStore }).gtfsStore;
      const match = ARTIFACT_PATTERN.exec(req.params.artifact);
      if (!match) {
        reply.status(404).send();
        return;
      }
      const requestedHash = match[1];
      if (requestedHash !== store.getShapesHash()) {
        reply.status(404).send();
        return;
      }
      reply
        .header("Content-Type", "application/json")
        .header("Cache-Control", "public, max-age=2592000, immutable")
        .header("ETag", `"${requestedHash}"`)
        .send(store.getShapesBody());
    },
  );
}
