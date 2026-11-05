import type { FastifyInstance } from "fastify";
import type { GtfsRealtimePoller } from "../gtfs/realtime.js";

/**
 * Registers `GET /api/health/rt`, reporting per-feed poller status.
 *
 * Response shape:
 *   { overall: "ok" | "degraded" | "failed" | "disabled", feeds: FeedHealth[] }
 *
 * `overall` semantics:
 *   - disabled: no poller registered, or poller has zero feeds. Returns HTTP 503.
 *   - ok:       every feed has status "ok".
 *   - degraded: at least one "ok" and at least one non-"ok".
 *   - failed:   at least one feed, but none are "ok".
 */
export function registerRtHealthRoute(
  app: FastifyInstance,
  getPoller: () => GtfsRealtimePoller | null,
): void {
  app.get("/api/health/rt", async (_req, reply) => {
    const poller = getPoller();
    if (!poller) {
      return reply.code(503).send({ overall: "disabled", feeds: [] });
    }
    const feeds = poller.getFeedHealth();
    if (feeds.length === 0) {
      // Defensive only — the poller constructor rejects empty-URL arrays, so a
      // live poller always exposes at least one feed. Kept for robustness.
      return reply.code(503).send({ overall: "disabled", feeds: [] });
    }
    const overall =
      feeds.every((f) => f.status === "ok")
        ? "ok"
        : feeds.some((f) => f.status === "ok")
          ? "degraded"
          : "failed";
    return reply.send({ overall, feeds });
  });
}
