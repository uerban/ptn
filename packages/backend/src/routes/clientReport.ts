import { ENGINE_FAILURE_KINDS } from "@pt/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * The allowlist IS the shared frontend EngineFailureKind union — one source of truth so the
 * classifier and this allowlist cannot drift.
 */
export const CLIENT_REPORT_KINDS = ENGINE_FAILURE_KINDS;
type ClientReportKind = (typeof CLIENT_REPORT_KINDS)[number];
const KINDS = new Set<string>(CLIENT_REPORT_KINDS);

export interface ClientReportDeps {
  /** Increment the per-kind counter. */
  inc: (labels: { kind: ClientReportKind }) => void;
}

/**
 * Handler for `POST /api/client-report` (nginx strips `/api/<city>/`). Opt-in engine-failure
 * report. Validates `kind` against the allowlist so a malformed client cannot mint arbitrary
 * metric series. Emits NO request IP and persists no body — only the counter + a coarse log
 * line.
 */
export function createClientReportHandler(deps: ClientReportDeps) {
  return async function clientReportHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      reply.status(400).send({ error: { code: "INVALID_BODY", message: "Body must be an object" } });
      return;
    }
    const kind = (body as { kind?: unknown }).kind;
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      reply.status(400).send({
        error: { code: "INVALID_KIND", message: `kind must be one of: ${[...CLIENT_REPORT_KINDS].join(", ")}` },
      });
      return;
    }
    deps.inc({ kind: kind as ClientReportKind });
    // No IP, no body: a coarse structured line only.
    request.log.info({ kind }, "client engine-failure report");
    reply.status(204).send();
  };
}
