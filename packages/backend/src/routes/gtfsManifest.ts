import type { FastifyRequest, FastifyReply } from "fastify";
import { BUNDLE_HASH_HEADER, REALTIME_HEADER } from "@pt/shared";
import type { ManifestSnapshot } from "../gtfs/scheduler.js";

export interface GtfsManifestDeps {
  /** Single manifest snapshot (R4). */
  getManifestSnapshot: () => ManifestSnapshot | null;
  /** Previous-good bundle hash even when the current parse is corrupt (R15).
   *  Optional; absent ⇒ no hash on the 503. */
  getLastKnownBundleHash?: () => string | null;
  /** `X-PT-Realtime` value (see `formatRealtimeHeader`), computed once at
   *  startup from the configured feeds. Sent on 200 and 304, even when empty.
   *  Absent ⇒ no header. */
  realtimeHeader?: string;
}

export function createGtfsManifestHandler(deps: GtfsManifestDeps) {
  return async function gtfsManifestHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const snapshot = deps.getManifestSnapshot();
    if (!snapshot) {
      const lastHash = deps.getLastKnownBundleHash?.() ?? null;
      const r = reply.status(503);
      if (lastHash) r.header(BUNDLE_HASH_HEADER, lastHash); // R15
      r.send({ error: { code: "MANIFEST_UNAVAILABLE", message: "No bundle has been published yet" } });
      return;
    }
    const etag = `"${snapshot.contentEtag}"`;
    if (request.headers["if-none-match"] === etag) {
      const r = reply.status(304).header("ETag", etag).header(BUNDLE_HASH_HEADER, snapshot.bundleHash);
      if (deps.realtimeHeader !== undefined) r.header(REALTIME_HEADER, deps.realtimeHeader);
      r.send();
      return;
    }
    if (deps.realtimeHeader !== undefined) reply.header(REALTIME_HEADER, deps.realtimeHeader);
    reply
      .status(200)
      .header("Content-Type", "application/json")
      .header("Cache-Control", "no-cache")
      .header("ETag", etag)
      .header("Vary", "Accept-Encoding")
      .header(BUNDLE_HASH_HEADER, snapshot.bundleHash)
      .send(snapshot.parsed);
  };
}
