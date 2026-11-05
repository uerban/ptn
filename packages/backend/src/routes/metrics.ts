import Fastify, { type FastifyInstance } from "fastify";
import { metricsRegistry } from "../metrics/registry.js";

/**
 * Resolve the bind host from env. Pure function so the safety property — that
 * unset / empty / whitespace `METRICS_HOST` falls back to loopback — is
 * unit-testable without standing up a Fastify listener. Refactor with care:
 * a future `process.env.METRICS_HOST ?? "127.0.0.1"` looks equivalent but
 * silently accepts `METRICS_HOST=""` from compose and lets it through to Node's
 * `net.Server.listen`, which binds to `::` (dual-stack, all interfaces).
 */
export function resolveMetricsHost(env: NodeJS.ProcessEnv): string {
  return env.METRICS_HOST?.trim() || "127.0.0.1";
}

export interface MetricsServerOptions {
  /** Port to bind. 0 = OS-assigned (useful for tests). Default 9100 in production. */
  port: number;
  /** Operating profile string (stroll / ride / hover). */
  profile: string;
  /**
   * Bind host. Caller picks deliberately — the env-var boundary in `index.ts`
   * defaults to `127.0.0.1` when `METRICS_HOST` is unset or blank, so a stray
   * deploy never accidentally exposes `/metrics` on the LAN. Override via
   * `METRICS_HOST=0.0.0.0` in compose when scraping from a sibling container
   * (e.g. nginx → backend-*:9100 → external Prometheus). Anything broader than
   * the container bridge should still be gated by an upstream ACL.
   */
  host: string;
}

export interface MetricsResponse {
  version: 1;
  profile: string;
  note: string;
  process: {
    heapUsedBytes: number;
    heapTotalBytes: number;
    rssBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  identity: null | { bytes: number; items: Record<string, number> };
  canonical: null | { bytes: number; items: Record<string, number> };
  mapView: null | { bytes: number; items: Record<string, number> };
  routingView: null | { bytes: number; items: Record<string, number> };
}

export async function startMetricsServer(opts: MetricsServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/api/health/metrics", async (): Promise<MetricsResponse> => {
    const m = process.memoryUsage();
    return {
      version: 1,
      profile: opts.profile,
      note: "internal — may break between minor versions",
      process: {
        heapUsedBytes: m.heapUsed,
        heapTotalBytes: m.heapTotal,
        rssBytes: m.rss,
        externalBytes: m.external,
        arrayBuffersBytes: m.arrayBuffers,
      },
      identity: null,
      canonical: null,
      mapView: null,
      routingView: null,
    };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", metricsRegistry.registry.contentType);
    reply.send(await metricsRegistry.registry.metrics());
  });

  await app.listen({ port: opts.port, host: opts.host });
  metricsRegistry.metricsSidecarUp.set(1);
  return app;
}
