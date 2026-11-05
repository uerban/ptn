import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Closed allowlist of telemetry event names. Unknown names are rejected at
 * the HTTP boundary AND at the type system: programmatic callers of `emit`
 * are compile-checked, so a misspelling (`"absurd_coutdown"` for instance)
 * is a TypeScript error rather than a silent metric drop.
 *
 * Each event maps to a named counter (`pt_<event>_total`) defined in
 * `metricsRegistry`. Adding a new event requires a spec amendment plus a
 * counter declaration — open-ended events would defeat cardinality control
 * and undermine the post-launch absurd-countdown evidence trail.
 */
const ALLOWED_EVENT_NAMES = [
  "sanity_clamp",
  "bundle_thrash",
  "truncated_lookahead",
  "absurd_countdown",
] as const;

export type TelemetryEventName = (typeof ALLOWED_EVENT_NAMES)[number];

export interface TelemetryEvent {
  event: TelemetryEventName;
  value?: number;
  tags?: Record<string, string>;
}

export interface TelemetryDeps {
  /** Forward each validated event into the metrics registry (e.g. `metricsRegistry.emitTelemetry`). */
  emit: (event: TelemetryEvent) => void;
}

/**
 * Runtime mirror of `TelemetryEventName` for the HTTP boundary, where the
 * request body arrives as `unknown` and the literal-union type can't help.
 * Typed as `ReadonlySet<string>` so `.has(rawString)` typechecks; once the
 * lookup succeeds, the runtime narrowing is sound and the value is
 * downcasted to `TelemetryEventName` before reaching `emit`.
 */
const ALLOWED_EVENTS: ReadonlySet<string> = new Set<string>(ALLOWED_EVENT_NAMES);
const MAX_EVENTS_PER_REQUEST = 100;
const MAX_TAG_KEYS = 8;
const ALLOWED_TAG_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function createTelemetryHandler(deps: TelemetryDeps) {
  return async function telemetryHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!Array.isArray(request.body)) {
      reply.status(400).send({ error: { code: "INVALID_BODY", message: "Body must be an array" } });
      return;
    }
    if (request.body.length > MAX_EVENTS_PER_REQUEST) {
      reply.status(400).send({ error: { code: "TOO_MANY_EVENTS", message: `>${MAX_EVENTS_PER_REQUEST} events` } });
      return;
    }

    for (const raw of request.body as unknown[]) {
      if (!raw || typeof raw !== "object") {
        reply.status(400).send({ error: { code: "INVALID_EVENT", message: "Event must be an object" } });
        return;
      }
      const e = raw as Partial<TelemetryEvent>;
      if (typeof e.event !== "string" || !ALLOWED_EVENTS.has(e.event)) {
        reply.status(400).send({
          error: { code: "INVALID_EVENT_NAME", message: `event must be one of: ${[...ALLOWED_EVENTS].join(", ")}` },
        });
        return;
      }
      if (e.value !== undefined && (typeof e.value !== "number" || !Number.isFinite(e.value))) {
        reply.status(400).send({ error: { code: "INVALID_EVENT_VALUE", message: "value must be a finite number" } });
        return;
      }
      if (e.tags !== undefined) {
        if (typeof e.tags !== "object" || Object.keys(e.tags).length > MAX_TAG_KEYS) {
          reply.status(400).send({
            error: { code: "INVALID_EVENT_TAGS", message: `tags must be an object with ≤${MAX_TAG_KEYS} keys` },
          });
          return;
        }
        for (const [k, v] of Object.entries(e.tags)) {
          if (typeof v !== "string" || v.length > 64) {
            reply.status(400).send({
              error: { code: "INVALID_EVENT_TAG", message: `tag values must be strings ≤64 chars` },
            });
            return;
          }
          if (!ALLOWED_TAG_KEY_RE.test(k)) {
            reply.status(400).send({
              error: { code: "INVALID_EVENT_TAG_KEY", message: "tag keys must match ^[a-z][a-z0-9_]*$" },
            });
            return;
          }
        }
      }
      deps.emit({ event: e.event, value: e.value, tags: e.tags });
    }

    reply.status(204).send();
  };
}
