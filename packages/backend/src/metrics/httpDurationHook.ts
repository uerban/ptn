import type { FastifyInstance } from "fastify";
import { metricsRegistry } from "./registry.js";

// Per-request hrtime stash. Module augmentation gives us a typed slot on
// FastifyRequest without `as any` casts that would silently break under
// future Fastify type changes.
declare module "fastify" {
  interface FastifyRequest {
    _ptnHttpStartHrTime?: bigint;
  }
}

/**
 * Routes excluded from the duration histogram. Health probes fire every few
 * seconds from the orchestrator and would dominate the histogram with
 * sub-millisecond noise that obscures real-traffic p99. Per-deployment
 * additions (e.g. internal metrics scrape paths) flow through the
 * `skipRoutes` option.
 */
const DEFAULT_SKIP_ROUTES: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/health/live",
  "/api/health/ready",
  "/api/version",
]);

interface HookOptions {
  skipRoutes?: ReadonlySet<string>;
}

/**
 * Install `onRequest` / `onResponse` Fastify hooks that record per-request
 * latency into `pt_http_request_duration_seconds`. The histogram's `route`
 * label is Fastify's matched route template (not raw URL), so cardinality
 * is bounded by the registered route set. Unmatched paths fall under
 * `__unmatched__`.
 *
 * **Install order matters.** Call this BEFORE registering plugins that may
 * short-circuit `onRequest` with `reply.send()` (cors preflights,
 * `@fastify/rate-limit` 429s, city-guard rejections). Otherwise their
 * `onRequest` runs first, ours never fires, and rejected traffic is silently
 * absent from the histogram while the per-request `onResponse` still runs
 * (without a start time it's dropped by the `start === undefined` guard).
 *
 * `skipRoutes` keys are matched against the route TEMPLATE (the same value
 * Fastify exposes via `request.routeOptions.url`), not the raw request URL.
 * `Set("/api/health/foo?bar")` would never skip anything.
 */
export function installHttpDurationHook(
  app: FastifyInstance,
  opts: HookOptions = {},
): void {
  const skip = opts.skipRoutes ?? DEFAULT_SKIP_ROUTES;
  app.addHook("onRequest", async (request) => {
    request._ptnHttpStartHrTime = process.hrtime.bigint();
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "__unmatched__";
    if (skip.has(route)) return;
    const start = request._ptnHttpStartHrTime;
    if (start === undefined) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    metricsRegistry.httpRequestDurationSeconds.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      seconds,
    );
  });
}
