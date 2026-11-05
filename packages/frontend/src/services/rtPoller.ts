import { api } from "./api.ts";
import { getPolicy } from "../stores/privacyStore.ts";
import type { RtRouteUpdate } from "@pt/shared";
import {
  RT_CLIENT_IDLE_INTERVAL_MS,
  RT_CLIENT_NAVIGATE_INTERVAL_MS,
  RT_CLIENT_TRANSFER_INTERVAL_MS,
} from "@pt/shared/constants";

type RtMode = "idle" | "navigating" | "transfer";
type RtCallback = (update: RtRouteUpdate) => void;

const INTERVALS: Record<RtMode, number> = {
  idle: RT_CLIENT_IDLE_INTERVAL_MS,
  navigating: RT_CLIENT_NAVIGATE_INTERVAL_MS,
  transfer: RT_CLIENT_TRANSFER_INTERVAL_MS,
};

/**
 * The realTimePolling privacy axis, read at every poll — the level can change
 * while the poller runs. "disabled-schedule-only" never asks; "backend-
 * foreground-only" asks only while the page is visible. Every live-data
 * surface (guidance, result cards, line preview) polls through here, so this
 * is the one place the axis has to hold.
 */
function pollingAllowed(): boolean {
  const mode = getPolicy().realTimePolling;
  if (mode === "disabled-schedule-only") return false;
  if (
    mode === "backend-foreground-only" &&
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return false;
  }
  return true;
}

export class RtPoller {
  private subscriptions = new Map<string, RtCallback>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  private mode: RtMode = "idle";

  subscribe(routeId: string, callback: RtCallback): void {
    this.subscriptions.set(routeId, callback);
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
    // `starting` covers the window where the first poll is in flight but no
    // timer exists yet — without it, two rapid `subscribeRoutes` calls (each
    // calls `start()`) launch two concurrent poll loops.
    if (this.timer || this.starting) return;
    this.starting = true;
    this.poll().then(() => {
      if (!this.starting) return; // stop() arrived mid-first-poll
      this.starting = false;
      this.scheduleNext();
    });
  }

  stop(): void {
    this.starting = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    const base = this.getIntervalMs();
    const jitter = base * 0.3 * (Math.random() * 2 - 1);
    this.timer = setTimeout(async () => {
      await this.poll();
      this.scheduleNext();
    }, Math.round(base + jitter));
  }

  private async poll(): Promise<void> {
    if (!pollingAllowed()) return;
    const entries = [...this.subscriptions.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([routeId, callback]) => {
        const update = await api.fetchRouteRt(routeId);
        callback(update);
      }),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(`RT poll failed for route ${entries[i][0]}:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
  }
}
