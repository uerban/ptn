import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { HealthStatus } from "@pt/shared";
import { ymdLocal, yyyymmddToLocalMidnight } from "@pt/shared";
import { FEED_STALE_DAYS } from "../health/feedStaleConstants.js";

export async function getHealth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const registry = (request.server as any).adapters;
  const adapters = registry.all();

  const checks = await Promise.all(
    adapters.map(async (adapter: any) => {
      const start = performance.now();
      let healthy = false;
      try {
        healthy = await adapter.healthCheck();
      } catch {
        healthy = false;
      }
      const elapsed = Math.round(performance.now() - start);
      return {
        name: adapter.name as string,
        healthy,
        responseTimeMs: elapsed,
      };
    })
  );

  const adapterStatuses: HealthStatus["adapters"] = {};
  for (const check of checks) {
    adapterStatuses[check.name] = {
      healthy: check.healthy,
      responseTimeMs: check.responseTimeMs,
    };
  }

  const allHealthy = checks.every((c) => c.healthy);
  const anyHealthy = checks.some((c) => c.healthy);

  const status: HealthStatus = {
    status: allHealthy ? "ok" : anyHealthy ? "degraded" : "down",
    adapters: adapterStatuses,
    timestamp: new Date().toISOString(),
  };

  return reply.status(allHealthy ? 200 : 503).send(status);
}

/**
 * Producer-artifact presence reporter (I-3). A narrow read-only slice of `ProducerArtifacts` —
 * just the two `/health/ready` projections, so the health route stays decoupled from the
 * loader's full surface (and so backend mode, where no loader exists, simply omits the fields).
 */
export interface HealthProbeDeps {
  producerArtifacts?: {
    artifactsPresent(): { tripRoute: boolean; stopCell: boolean };
    loadedShas(): { tripRoute?: string; stopCell?: string };
    loadedGenerationId(): string | null;
  };
  poiTileStatus?: () => {
    configured: boolean;
    ready: boolean;
    error: string | null;
  };
}

export function registerHealthProbes(fastify: FastifyInstance, deps: HealthProbeDeps = {}) {
  const producerArtifacts = deps.producerArtifacts;
  fastify.get("/api/health/ready", async (_req, reply) => {
    const store = (fastify as any).gtfsStore;
    if (!store) return reply.status(503).send({ status: "not_ready", reason: "Store not initialized" });
    if (!store.isReady()) {
      return reply.status(503).send({ status: "not_ready", reason: "GTFS data not loaded" });
    }
    const lastUpdated: Date | null = store.getLastUpdated?.() ?? null;
    const feedAgeSeconds = lastUpdated ? Math.floor((Date.now() - lastUpdated.getTime()) / 1000) : null;
    const scheduler = (fastify as any).gtfsScheduler;
    const ingestionPath: string = scheduler?.loaderMode ?? "unknown";
    const serviceWindowAnchor: number | null = scheduler?.serviceWindowAnchor ?? null;
    let serviceWindowAgeDays: number | null = null;
    let serviceWindowStale = false;
    if (serviceWindowAnchor !== null) {
      const anchorStr = String(serviceWindowAnchor);
      const anchorDate = yyyymmddToLocalMidnight(anchorStr);
      const todayStr = ymdLocal(new Date());
      const todayDate = yyyymmddToLocalMidnight(todayStr);
      serviceWindowAgeDays = Math.round((todayDate.getTime() - anchorDate.getTime()) / 86400_000);
      serviceWindowStale =
        (ingestionPath === "ptb" || ingestionPath === "ptb_fallback") &&
        serviceWindowAgeDays > FEED_STALE_DAYS;
    }
    const bbs = scheduler?.bundleBuildState;
    const scheduleTileSource: "backend" | "producer" =
      process.env.PT_SCHEDULE_TILE_SOURCE === "producer" ? "producer" : "backend";
    let scheduleBundle:
      | { configured: boolean; everBuilt: boolean; lastBuildStatus: "success" | "failure" | null; lastSuccessAgeSeconds: number | null; failing: boolean; oversizedLeafCount: number; scheduleTileSource: "backend" | "producer" }
      | null = null;
    if (bbs) {
      scheduleBundle = bbs.configured
        ? {
            configured: true,
            everBuilt: bbs.everBuilt,
            lastBuildStatus: bbs.lastBuildStatus,
            lastSuccessAgeSeconds: bbs.lastSuccessMs != null ? Math.max(0, Math.floor((Date.now() - bbs.lastSuccessMs) / 1000)) : null,
            failing: bbs.lastBuildStatus === "failure" && !bbs.everBuilt,
            oversizedLeafCount: bbs.oversizedLeafCount ?? 0,
            scheduleTileSource,
          }
        : { configured: false, everBuilt: false, lastBuildStatus: null, lastSuccessAgeSeconds: null, failing: false, oversizedLeafCount: 0, scheduleTileSource };
    }
    // Producer-artifact presence (I-3), mirroring pt-serve's `departuresIdxPresent`. Present ONLY
    // in producer mode (when the loader is wired in index.ts); in backend mode `producerArtifacts`
    // is absent and the fields are omitted entirely — the artifacts are never loaded there.
    const artifactFields: Record<string, unknown> = {};
    if (producerArtifacts) {
      const present = producerArtifacts.artifactsPresent();
      const shas = producerArtifacts.loadedShas();
      artifactFields.tripRouteArtifactPresent = present.tripRoute;
      artifactFields.stopCellArtifactPresent = present.stopCell;
      artifactFields.tripRouteArtifactSha256 = shas.tripRoute ?? null;
      artifactFields.stopCellArtifactSha256 = shas.stopCell ?? null;
      // The loaded generation (cache key) — for prod diagnosis over plain HTTP:
      // confirms WHICH generation the artifacts came from. `null` ⇒ nothing
      // loaded (cold start / mid-publish).
      artifactFields.loadedGenerationId = producerArtifacts.loadedGenerationId();
    }

    const poiTile = deps.poiTileStatus?.();
    return {
      status: "ready",
      city: process.env.CITY_ID,
      feedAgeSeconds,
      ingestionPath,
      serviceWindowAnchor,
      serviceWindowAgeDays,
      serviceWindowStale,
      scheduleBundle,
      ...(poiTile ? { poiTile } : {}),
      ...artifactFields,
    };
  });

  fastify.get("/api/health/startup", async (_req, reply) => {
    const store = (fastify as any).gtfsStore;
    const registry = (fastify as any).adapters;
    if (!store) return reply.status(503).send({ status: "not_ready", reason: "Store not initialized" });
    if (!registry) return reply.status(503).send({ status: "not_ready", reason: "Adapters not initialized" });
    const gtfsReady = store.isReady();
    const adapterResults = await Promise.all(
      registry.all().map(async (a: any) => ({
        name: a.name as string,
        healthy: await a.healthCheck().catch(() => false),
      }))
    );
    const allHealthy = gtfsReady && adapterResults.every((a: any) => a.healthy);
    if (!allHealthy) {
      return reply.status(503).send({
        status: "starting",
        gtfs: gtfsReady ? "loaded" : "loading",
        adapters: adapterResults,
      });
    }
    return { status: "started", city: process.env.CITY_ID, adapters: adapterResults };
  });
}
