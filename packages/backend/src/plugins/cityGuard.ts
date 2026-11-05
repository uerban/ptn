import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Reject requests whose `X-PT-Expected-City` header disagrees with the
 * backend's configured CITY_ID.
 *
 * Set by nginx per-location: `/api/vilnius/*` → `X-PT-Expected-City: vilnius`.
 * Rejects 502 before the handler runs — catches nginx → wrong-upstream
 * misroutes that no env/data check on the backend itself would catch
 * (the backend boots with a correct CITY_ID; it's nginx DNS that routes
 * traffic to the wrong container).
 *
 * Requests without the header pass through unchanged (direct-to-backend
 * access, internal loopback, unit tests).
 */
export interface CityGuardOptions {
  /** The backend's configured CITY_ID. */
  cityId: string;
}

const HEADER = "x-pt-expected-city";

export async function registerCityGuard(
  app: FastifyInstance,
  opts: CityGuardOptions,
): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const expected = req.headers[HEADER];
    if (expected === undefined) return;
    const expectedStr = Array.isArray(expected) ? expected[0] : expected;
    if (!expectedStr) return;
    if (expectedStr.toLowerCase() !== opts.cityId.toLowerCase()) {
      req.log.error(
        { expected: expectedStr, actual: opts.cityId, path: req.url },
        "City guard: request routed to wrong backend — nginx upstream misaligned",
      );
      reply.code(502).send({
        error: "Backend misroute",
        message:
          `This backend is configured for city '${opts.cityId}' but received a request intended for '${expectedStr}'. ` +
          `Check nginx upstream resolution and Docker service DNS in the deployment.`,
        expected: expectedStr,
        actual: opts.cityId,
      });
    }
  });
}
