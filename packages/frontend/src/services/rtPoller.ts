import { api } from "./api.ts";
import { canUse } from "../privacy/canUse.ts";
import { REALTIME_FLOW } from "./departuresPolicy.ts";
import type { RtRouteUpdate } from "@pt/shared";
import {
  RT_CLIENT_IDLE_INTERVAL_MS,
  RT_CLIENT_NAVIGATE_INTERVAL_MS,
  RT_CLIENT_TRANSFER_INTERVAL_MS,
} from "@pt/shared/constants";

type RtMode = "idle" | "navigating" | "transfer";
type RtCallback = (update: RtRouteUpdate) => void;
type RtSubscription = { callback: RtCallback };

const INTERVALS: Record<RtMode, number> = {
  idle: RT_CLIENT_IDLE_INTERVAL_MS,
  navigating: RT_CLIENT_NAVIGATE_INTERVAL_MS,
  transfer: RT_CLIENT_TRANSFER_INTERVAL_MS,
};

/**
 * Live departures, resolved at every poll — the decision can change (also in
 * another tab) while the poller runs. Every live-data surface (guidance,
 * result cards, line preview) polls through here, so this is the one place
 * the decision has to hold. A hidden page never polls: the next tick after
 * it is shown again polls as usual.
 */
function pollingAllowed(): boolean {
  if (!canUse(REALTIME_FLOW)) return false;
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export class RtPoller {
  private subscriptions = new Map<string, RtSubscription>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private mode: RtMode = "idle";

  subscribe(routeId: string, callback: RtCallback): void {
    // Reconciliation may repeat a still-active hold. Preserve that identity,
    // but a replacement or remove/re-add gets a new subscription lifetime.
    if (this.subscriptions.get(routeId)?.callback === callback) return;
    this.subscriptions.set(routeId, { callback });
  }

  unsubscribe(routeId: string): void {
    this.subscriptions.delete(routeId);
  }

  setMode(mode: RtMode): void {
    const changed = this.mode !== mode;
    this.mode = mode;
    if (changed && this.timer) {
      this.stop();
      this.start();
    }
  }

  getIntervalMs(): number {
    return INTERVALS[this.mode];
  }

  start(): void {
    // A running loop includes its in-flight request, not only its timer.
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    void this.poll(generation).then(() => this.scheduleNext(generation));
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private scheduleNext(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const base = this.getIntervalMs();
    const jitter = base * 0.3 * (Math.random() * 2 - 1);
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.poll(generation);
      this.scheduleNext(generation);
    }, Math.round(base + jitter));
  }

  private async poll(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || !pollingAllowed()) return;
    const entries = [...this.subscriptions.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([routeId, subscription]) => {
        const update = await api.fetchRouteRt(routeId);
        // Neither a stopped loop, released hold nor revoked permission owns
        // this late response. A re-added identical callback is a new hold.
        if (this.isCurrent(generation)
            && this.subscriptions.get(routeId) === subscription
            && pollingAllowed()) subscription.callback(update);
      }),
    );
    for (let i = 0; i < results.length; i++) {
      const [routeId, subscription] = entries[i];
      if (this.isCurrent(generation) && this.subscriptions.get(routeId) === subscription
          && results[i].status === "rejected") {
        console.warn(`RT poll failed for route ${entries[i][0]}:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
  }
}
