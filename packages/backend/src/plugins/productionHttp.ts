import type { BuildInfo } from "@pt/shared";
import type { FastifyInstance } from "fastify";

type ResponseBuildInfo = Pick<BuildInfo, "version" | "commit">;

/**
 * Register headers that belong to the production HTTP surface. Reference
 * harnesses call this registrar too, so parity tests exercise the real hook.
 */
export function installProductionHttpHook(
  app: FastifyInstance,
  buildInfo: ResponseBuildInfo,
): void {
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.getHeader("cache-control")) {
      reply.header("Cache-Control", "no-store");
    }
    reply.header("X-App-Version", buildInfo.version);
    reply.header("X-App-Commit", buildInfo.commit);
    reply.header("X-API-Version", "1");
  });
}
