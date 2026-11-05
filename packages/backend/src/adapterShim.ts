/**
 * The adapter shim — one cityless Node process owning the three routes that are
 * NOT part of the serving plane.
 *
 * `/stops/search`, `/nearby` and `/alerts` never read the GTFS bundle. All three
 * are thin proxies over the routing-adapter registry (`adapters/registry.ts`:
 * MOTIS against `MOTIS_URL`, optional OTP against `OTP_BASE_URL`), selected
 * per-request by `?adapter=`. Porting them to pt-serve would give a server that
 * has been self-contained over a local bundle an outbound third-party HTTP layer
 * on the request path — so they stay on Node, deliberately (decided 2026-08-08).
 *
 * "Node retirement" therefore means retiring the per-city SERVING plane, not
 * deleting Node. This process is what is left.
 *
 * WHY ONE PROCESS AND NOT FIVE. `createAdapterRegistry(cityBbox?)` takes the
 * bbox as OPTIONAL, and its only consumer is `orderLocalFirst` in
 * `adapters/motis.ts` — a result-ordering nicety that moves in-bbox stops ahead
 * of out-of-bbox ones on `searchStops`. Nothing else in the registry is
 * city-bound. So resolving the bbox per request from the path's city slug keeps
 * full parity with a per-city process, and five shim containers would just
 * reintroduce the fan-out this whole effort exists to remove.
 *
 * URL SHAPE DIVERGENCE FROM THE PER-CITY BACKENDS. nginx strips `/api/<city>/`
 * before proxying to `backend-<city>`, so those processes register
 * `/api/stops/search`. This one needs the slug to pick a bbox, so its nginx
 * locations do NOT rewrite and it registers `/api/:city/stops/search`. That
 * difference is also the plane discriminator: the `route` label on
 * `http_request_duration_seconds` reads `/api/:city/stops/search` here and
 * `/api/stops/search` on a per-city backend, so a scrape attributes a request
 * without needing a new counter.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { fileURLToPath } from "node:url";

import { createAdapterRegistry, type AdapterRegistry } from "./adapters/registry.js";
import { getCityProfile } from "./harness/cities/index.js";
import { searchStops } from "./routes/search.js";
import { getNearby } from "./routes/nearby.js";
import { getAlerts } from "./routes/alerts.js";
import { registerRateLimit, rateLimitForRoute } from "./plugins/rateLimit.js";
import { installHttpDurationHook } from "./metrics/httpDurationHook.js";
import { installProductionHttpHook } from "./plugins/productionHttp.js";
import { resolveMetricsHost, startMetricsServer } from "./routes/metrics.js";
import { buildInfo } from "./generated/buildInfo.js";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

/**
 * Registries are memoised per slug. Construction is cheap (two `new`s and an
 * env read) but it happens on the request path here rather than once at boot,
 * and the MOTIS adapter holds a keep-alive agent worth reusing across requests.
 */
const registryBySlug = new Map<string, AdapterRegistry>();

export function registryForCity(slug: string): AdapterRegistry | null {
  const profile = getCityProfile(slug);
  if (!profile) return null;
  const key = profile.id;
  let registry = registryBySlug.get(key);
  if (!registry) {
    registry = createAdapterRegistry(profile.bbox);
    registryBySlug.set(key, registry);
  }
  return registry;
}

type CityParams = { city: string };

/**
 * Resolve the per-request registry and hand off to the shared handler.
 *
 * An unknown slug is a 404, not a bbox-less degrade. Degrading would be
 * survivable — `orderLocalFirst` is documented as a no-op without a bbox — but
 * it would make "city added to nginx before its profile exists" silently
 * downgrade result ordering instead of failing where an operator can see it.
 */
function withCityRegistry(
  handler: (request: FastifyRequest<never>, reply: FastifyReply) => Promise<unknown>,
) {
  return async function resolveThenHandle(
    request: FastifyRequest<{ Params: CityParams }>,
    reply: FastifyReply,
  ) {
    const registry = registryForCity(request.params.city ?? "");
    if (!registry) {
      return reply.status(404).send({
        error: {
          code: "UNKNOWN_CITY",
          message: `No city profile for '${request.params.city}'`,
        },
      });
    }
    (request as unknown as { adapters: AdapterRegistry }).adapters = registry;
    return handler(request as unknown as FastifyRequest<never>, reply);
  };
}

export async function buildShim() {
  const app = Fastify({ logger: true });

  // Same ordering rationale as the per-city backend: install before
  // cors/rate-limit so rejected traffic (preflights, 429s) still lands in the
  // histogram with the right status_code instead of disappearing.
  installHttpDurationHook(app);

  await app.register(cors, { origin: true });
  await registerRateLimit(app);
  installProductionHttpHook(app, buildInfo);

  // Declared up-front so every request object has the same shape — assigning an
  // undeclared property per request would deoptimise Fastify's hidden class.
  app.decorateRequest("adapters", null);

  // NO city guard. The per-city backends compare `X-PT-Expected-City` against
  // their own boot-time CITY_ID to catch an nginx→wrong-upstream misroute; this
  // process has no configured city to compare against, and it reads the slug
  // from the path it was actually asked for, so the misroute class the guard
  // exists to catch cannot occur here.
  app.get<{ Params: CityParams }>(
    "/api/:city/stops/search",
    { config: { rateLimit: rateLimitForRoute("stopsBbox") } },
    withCityRegistry(searchStops as never),
  );
  app.get<{ Params: CityParams }>(
    "/api/:city/nearby",
    { config: { rateLimit: rateLimitForRoute("stopsBbox") } },
    withCityRegistry(getNearby as never),
  );
  // No rate limit, matching the per-city backend: `/api/alerts` takes no
  // caller-controlled parameters beyond `?adapter=`, so it has no bucket in
  // RATE_LIMIT_DEFAULTS. nginx's read_burst zone still applies in front.
  app.get<{ Params: CityParams }>("/api/:city/alerts", withCityRegistry(getAlerts as never));

  // Liveness only. There is no readiness to report: this process holds no
  // bundle, no generation and no feed, so it is serving the moment it binds.
  // Upstream (Transitous/OTP) availability is deliberately NOT probed here —
  // that would make a flaky third party able to take the container out of
  // rotation, and the routes already answer 502 ADAPTER_ERROR per request.
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

async function main() {
  const app = await buildShim();

  let metricsApp: Awaited<ReturnType<typeof startMetricsServer>> | null = null;
  // Must be registered before listen — Fastify throws
  // FST_ERR_INSTANCE_ALREADY_LISTENING on addHook once the server is listening.
  app.addHook("onClose", async () => {
    if (metricsApp) await metricsApp.close();
  });

  await app.listen({ port: PORT, host: HOST });

  const metricsPort = parseInt(process.env.PORT_METRICS ?? "9100", 10);
  const metricsHost = resolveMetricsHost(process.env);
  try {
    metricsApp = await startMetricsServer({
      port: metricsPort,
      host: metricsHost,
      profile: process.env.PT_PROFILE ?? "shim",
    });
    app.log.info({ port: metricsPort, host: metricsHost }, "metrics server listening");
  } catch (err) {
    app.log.warn(
      { port: metricsPort, host: metricsHost, err },
      "metrics server failed to start — continuing without it",
    );
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      void app.close().then(() => process.exit(0));
    });
  }
}

// Only boot when this file is the process entry-point, so tests can import
// `buildShim` without binding a port.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
