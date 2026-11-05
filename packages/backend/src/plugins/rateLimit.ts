import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

/**
 * Spec-required per-route limits. Keyed by a short route-family name.
 * Actual routes opt in via `config: { rateLimit: rateLimitForRoute("plan") }`
 * in their registration.
 */
export const RATE_LIMIT_DEFAULTS = {
  // The `departures` family (120/min) is gone with `/api/departures`. Its successor is rate-limited
  // in nginx instead — the `departures_burst` zone in packages/frontend/nginx.conf, applied per
  // city in nginx/city-proxies.inc — because the route now lives in pt-serve, which has no Fastify
  // plugin to opt into.
  /***/
  stopsBbox: { max: 60, timeWindow: "1 minute" },
  /***/
  routeById: { max: 60, timeWindow: "1 minute" },
  /***/
  plan: { max: 20, timeWindow: "1 minute" },
  /***/
  routingBundle: { max: 10, timeWindow: "1 minute" },
  /***/
  raptorBundle: { max: 10, timeWindow: "1 minute" },
  /***/
  scheduleTile: { max: 60, timeWindow: "1 minute" },
  /***/
  gtfsManifest: { max: 30, timeWindow: "1 minute" },
  /***/
  rtTile: { max: 60, timeWindow: "1 minute" },
  /***/
  telemetry: { max: 30, timeWindow: "1 minute" },
  /**
 * /api/client-report — opt-in engine-failure report
 */
  clientReport: { max: 30, timeWindow: "1 minute" },
} as const;

export type RouteFamily = keyof typeof RATE_LIMIT_DEFAULTS;

function envOverride(family: RouteFamily): number | null {
  const key = `PT_RATELIMIT_${family.toUpperCase()}_MAX`;
  const raw = process.env[key];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function rateLimitForRoute(family: RouteFamily): { max: number; timeWindow: string } {
  const base = RATE_LIMIT_DEFAULTS[family];
  if (process.env.PT_RATELIMIT_DISABLED === "1") {
    return { max: Number.MAX_SAFE_INTEGER, timeWindow: base.timeWindow };
  }
  const override = envOverride(family);
  return { max: override ?? base.max, timeWindow: base.timeWindow };
}

/**
 * Register @fastify/rate-limit on the app. When PT_RATELIMIT_DISABLED=1,
 * the plugin is still installed (so `config.rateLimit` references don't
 * error) but `max: Number.MAX_SAFE_INTEGER` effectively bypasses enforcement.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  const disabled = process.env.PT_RATELIMIT_DISABLED === "1";
  await app.register(rateLimit, {
    global: false,
    max: disabled ? Number.MAX_SAFE_INTEGER : 1000,
    timeWindow: "1 minute",
  });
  if (disabled) {
    app.log.warn("PT_RATELIMIT_DISABLED=1 — rate limiting is bypassed");
  }
}
