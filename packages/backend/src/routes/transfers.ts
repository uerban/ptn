import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { GtfsStore } from "../gtfs/store.js";

/**
 * Serves the pre-computed pedestrian transfers artifact (`transfers.bin`,
 * PTFT wire format) at `/api/<city>/transfers/fetch`. The edge proxy
 * (nginx in prod, vite dev proxy locally) strips `/api/<city>/` to `/api/`
 * before the request reaches Fastify, mirroring `/api/gtfs/shapes/...`.
 *
 * Caching: the TransfersStore pre-gzips the bytes once at load (or after a
 * mtime-triggered reload). The handler sends those bytes with the artifact
 * hash as a strong ETag and a short Cache-Control. If-None-Match short-circuits
 * to 304 when the client already has the current artifact.
 *
 * Substring match for Accept-Encoding (matching `gtfs-export.ts`): clients
 * either list `gzip` and want it or omit it; q=0 disable directives are
 * vanishingly rare and not worth parser complexity. Without gzip support we
 * fall back to raw bytes from the store.
 */
function clientAcceptsGzip(acceptEncoding: string | undefined): boolean {
  return acceptEncoding != null && /\bgzip\b/i.test(acceptEncoding);
}

export function registerTransfersRoute(app: FastifyInstance): void {
  app.get(
    "/api/transfers/fetch",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const store = (req.server as unknown as { gtfsStore: GtfsStore }).gtfsStore;
      const transfers = store.getTransfersStore();

      // Take an atomic snapshot — calling separate getters would risk a
      // mid-request reload where the ETag and body come from different
      // file generations, producing a permanent hash-mismatch for any
      // client caching by that ETag.
      const snapshot = transfers?.getSnapshot();
      if (!snapshot) {
        reply.status(404).send();
        return;
      }

      const etag = `"${snapshot.hash}"`;

      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch === etag) {
        // Vary on 304 too: HTTP caches keying by Accept-Encoding need to know
        // this resource has encoding-dependent representations even when the
        // body is empty.
        reply
          .header("Vary", "Accept-Encoding")
          .header("ETag", etag)
          .status(304)
          .send();
        return;
      }

      reply
        .header("Content-Type", "application/octet-stream")
        .header("ETag", etag)
        .header("Cache-Control", "public, max-age=300")
        .header("Vary", "Accept-Encoding");

      if (clientAcceptsGzip(req.headers["accept-encoding"])) {
        reply.header("Content-Encoding", "gzip").send(snapshot.gzipBytes);
      } else {
        reply.send(snapshot.bytes);
      }
    },
  );
}
