import type { FastifyInstance } from "fastify";

/**
 * Routing-bundle endpoints — phase-1 stubs.
 *

 * * /version: returns the scaffolding shape so the eventual client can branch on schema version
 * before attempting /fetch. No content-hash yet because no wire-format is defined. /fetch:
 * returns 404.
 */
export function registerRoutingBundleRoutes(app: FastifyInstance): void {
  app.get("/api/routing-bundle/version", async () => ({
    version: 1,
    schema: "unstable",
    ready: false,
    note: "Routing bundle serializer not yet shipped — stub endpoint.",
  }));

  app.get("/api/routing-bundle/fetch", async (_req, reply) => {
    return reply.code(404).send({
      error: "routing-bundle serializer not implemented",
      version_endpoint: "/api/routing-bundle/version",
    });
  });
}
