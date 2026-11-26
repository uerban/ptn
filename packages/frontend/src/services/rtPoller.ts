import { useSettingsStore } from "../stores/settingsStore.ts";
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
 * the decision has to hold. A hidden page stops its poll timer and resumes
 * when shown again.
 */
function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function pollingAllowed(): boolean {
  return pageVisible() && canUse(REALTIME_FLOW);
}

export class RtPoller {
  private subscriptions = new Map<string, RtSubscription>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private pollingGeneration: number | null = null;
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
    const base = INTERVALS[this.mode];
    if (this.mode === "idle" && import.meta.env.VITE_PTN_SEARCH_POWER_MODES === "1" &&
        useSettingsStore.getState().searchPowerMode === "battery-saver") return base * 2;
    return base;
  }

  start(): void {
    // A running loop includes its in-flight request, not only its timer.
    if (this.running) return;
    this.running = true;
    ++this.generation;
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    this.onVisibility();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private onVisibility = (): void => {
    if (!pageVisible()) {
      this.clearTimer();
    } else if (this.running && this.timer === null && this.pollingGeneration !== this.generation) {
      void this.runCycle(this.generation);
    }
  };

  private async runCycle(generation: number): Promise<void> {
    this.pollingGeneration = generation;
    try {
      await this.poll(generation);
    } finally {
      if (this.pollingGeneration === generation) this.pollingGeneration = null;
      this.scheduleNext(generation);
    }
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private scheduleNext(generation: number): void {
    if (!this.isCurrent(generation) || !pageVisible()) return;
    const base = this.getIntervalMs();
    const jitter = base * 0.3 * (Math.random() * 2 - 1);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle(generation);
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
