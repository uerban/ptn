import type { FastifyBaseLogger } from "fastify";
import type { GtfsStore } from "./store.ts";

const FEED_FETCH_TIMEOUT_MS = 15_000;
const MAX_DELAY_SECONDS = 1800;
const MIN_DELAY_SECONDS = -1800;

function clampDelaySeconds(
  delaySeconds: number,
  ctx: { tripId: string; cancelled: boolean; logger?: FastifyBaseLogger },
): number {
  if (!Number.isFinite(delaySeconds)) {
    ctx.logger?.debug(
      { tripId: ctx.tripId, rawDelay: delaySeconds },
      "GTFS-RT non-finite delaySeconds coerced to 0",
    );
    return 0;
  }
  if (delaySeconds > MAX_DELAY_SECONDS || delaySeconds < MIN_DELAY_SECONDS) {
    const clamped = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, delaySeconds));
    ctx.logger?.debug(
      { tripId: ctx.tripId, rawDelay: delaySeconds, clamped, cancelled: ctx.cancelled },
      "GTFS-RT delaySeconds clamped",
    );
    return clamped;
  }
  return delaySeconds;
}

export interface TripUpdate {
  delaySeconds: number;
  cancelled: boolean;
}

interface RealtimeOptionsCommon {
  pollIntervalMs: number;
  store: GtfsStore;
  logger: FastifyBaseLogger;
}

interface RealtimeOptionsSingle extends RealtimeOptionsCommon {
  tripUpdatesUrl: string;
  tripUpdatesUrls?: never;
}

interface RealtimeOptionsMulti extends RealtimeOptionsCommon {
  tripUpdatesUrls: string[];
  tripUpdatesUrl?: never;
}

export type RealtimeOptions = RealtimeOptionsSingle | RealtimeOptionsMulti;

export async function parseTripUpdatesBuffer(
  data: Uint8Array,
  logger?: FastifyBaseLogger,
): Promise<Map<string, TripUpdate>> {
  // IMPORTANT: gtfs-realtime-bindings is a CJS module. In ESM context, use dynamic import.
  const GtfsRealtimeBindings = await import("gtfs-realtime-bindings");
  const { transit_realtime } = GtfsRealtimeBindings.default ?? GtfsRealtimeBindings;
  const feed = transit_realtime.FeedMessage.decode(data);
  const updates = new Map<string, TripUpdate>();

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    const tripId = entity.tripUpdate.trip?.tripId;
    if (!tripId) continue;

    const cancelled =
      entity.tripUpdate.trip?.scheduleRelationship ===
      transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;

    let delaySeconds = 0;
    const stopTimeUpdates = entity.tripUpdate.stopTimeUpdate ?? [];
    if (stopTimeUpdates.length > 0) {
      const last = stopTimeUpdates[stopTimeUpdates.length - 1];
      delaySeconds = Number(last.departure?.delay ?? last.arrival?.delay ?? 0);
    }

    const update: TripUpdate = {
      delaySeconds: clampDelaySeconds(delaySeconds, { tripId, cancelled, logger }),
      cancelled,
    };

    // Key by tripId|startDate when the feed provides startDate so that
    // updates for one service day don't bleed into another.
    const startDate = entity.tripUpdate.trip?.startDate;
    if (startDate) {
      updates.set(`${tripId}|${startDate}`, update);
    }
    // Always store a tripId-only entry as fallback for feeds that omit
    // startDate on some entities.
    updates.set(tripId, update);
  }

  return updates;
}

export type FeedStatus = "ok" | "failed" | "pending";

export interface FeedHealth {
  url: string;
  status: FeedStatus;
  lastFetchedAt: number | null;
  lastError: string | null;
  entryCount: number;
}

export class GtfsRealtimePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly urls: string[];
  private readonly store: GtfsStore;
  private readonly logger: FastifyBaseLogger;
  private readonly pollIntervalMs: number;

  // Per-URL last successful update maps. Preserved across polls so a failed
  // feed does not wipe its last known state from the merged superset.
  private readonly lastUpdatesByUrl: Map<string, Map<string, TripUpdate>> = new Map();
  private readonly healthByUrl: Map<string, FeedHealth> = new Map();

  constructor(options: RealtimeOptions) {
    const singleUrl = (options as RealtimeOptionsSingle).tripUpdatesUrl;
    const multiUrls = (options as RealtimeOptionsMulti).tripUpdatesUrls;

    const hasSingle = singleUrl !== undefined;
    const hasMulti = multiUrls !== undefined;

    if (hasSingle && hasMulti) {
      throw new Error(
        "Provide either `tripUpdatesUrl` (single) or `tripUpdatesUrls` (array), not both.",
      );
    }
    if (!hasSingle && !hasMulti) {
      throw new Error(
        "Must provide `tripUpdatesUrl` or a non-empty `tripUpdatesUrls` array.",
      );
    }
    if (hasSingle && singleUrl === "") {
      throw new Error("`tripUpdatesUrl` must be a non-empty string.");
    }
    if (hasMulti && (multiUrls as string[]).length === 0) {
      throw new Error("`tripUpdatesUrls` must be a non-empty array.");
    }
    if (hasMulti && (multiUrls as string[]).some((u) => u === "")) {
      throw new Error("`tripUpdatesUrls` must not contain empty strings.");
    }

    this.urls = hasSingle ? [singleUrl as string] : [...(multiUrls as string[])];
    this.store = options.store;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs;

    for (const url of this.urls) {
      this.healthByUrl.set(url, {
        url,
        status: "pending",
        lastFetchedAt: null,
        lastError: null,
        entryCount: 0,
      });
    }
  }

  getFeedUrls(): string[] {
    return [...this.urls];
  }

  getFeedHealth(): FeedHealth[] {
    return this.urls.map((u) => ({ ...(this.healthByUrl.get(u) as FeedHealth) }));
  }

  start(): void {
    // `poll()` catches per-feed fetch errors itself, but a throw from the
    // store-apply step would otherwise surface as an unlogged
    // unhandledRejection (the scheduler's refresh loop guards the same way).
    const guarded = () =>
      void this.poll().catch((err) => this.logger.error({ err }, "rt poll failed"));
    guarded();
    this.timer = setInterval(guarded, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    await Promise.allSettled(this.urls.map((u) => this.pollOne(u)));

    // Merge all per-URL maps into a single superset.
    // Feeds appearing later in the URL list overwrite earlier ones on collision;
    // since conflicting tripIds across feeds would be a feed bug, this is a
    // deterministic resolution, not a policy.
    const merged = new Map<string, TripUpdate>();
    for (const url of this.urls) {
      const per = this.lastUpdatesByUrl.get(url);
      if (!per) continue;
      for (const [k, v] of per) merged.set(k, v);
    }
    this.store.setRealtimeUpdates(merged);
  }

  private async pollOne(url: string): Promise<void> {
    const health = this.healthByUrl.get(url) as FeedHealth;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        health.status = "failed";
        health.lastError = `HTTP ${response.status}`;
        health.lastFetchedAt = Date.now();
        this.logger.warn({ status: response.status, url }, "GTFS-RT fetch failed");
        return;
      }
      const buffer = await response.arrayBuffer();
      const updates = await parseTripUpdatesBuffer(new Uint8Array(buffer), this.logger);
      this.lastUpdatesByUrl.set(url, updates);
      health.status = "ok";
      health.lastError = null;
      health.lastFetchedAt = Date.now();
      health.entryCount = updates.size;
      this.logger.debug({ count: updates.size, url }, "GTFS-RT updates applied");
    } catch (err) {
      health.status = "failed";
      health.lastError = err instanceof Error ? err.message : String(err);
      health.lastFetchedAt = Date.now();
      this.logger.warn({ err, url }, "GTFS-RT poll error");
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
