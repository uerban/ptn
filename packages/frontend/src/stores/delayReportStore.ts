import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LatLon } from "@pt/shared";

export type DelayCategory =
  | "on_time"
  | "slight"
  | "significant"
  | "major"
  | "cancelled";

export interface DelayReport {
  id: string;
  tripId: string;
  routeId: string;
  routeShortName: string;
  timestamp: number;
  category: DelayCategory;
  location?: LatLon;
}

const MAX_REPORTS = 100;
const EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours

interface DelayReportState {
  reports: DelayReport[];
  addReport: (report: Omit<DelayReport, "id">) => void;
  getReportsForRoute: (routeId: string, withinMinutes?: number) => DelayReport[];
}

function pruneExpired(reports: DelayReport[]): DelayReport[] {
  const cutoff = Date.now() - EXPIRY_MS;
  return reports.filter((r) => r.timestamp >= cutoff);
}

export const useDelayReportStore = create<DelayReportState>()(
  persist(
    (set, get) => ({
      reports: [],

      addReport: (report) => {
        const newReport: DelayReport = {
          ...report,
          id: crypto.randomUUID(),
        };
        const pruned = pruneExpired(get().reports);
        const updated = [newReport, ...pruned].slice(0, MAX_REPORTS);
        set({ reports: updated });
      },

      getReportsForRoute: (routeId, withinMinutes = 120) => {
        const cutoff = Date.now() - withinMinutes * 60 * 1000;
        // Prune expired on access
        const pruned = pruneExpired(get().reports);
        if (pruned.length !== get().reports.length) {
          set({ reports: pruned });
        }
        return pruned.filter(
          (r) => r.routeId === routeId && r.timestamp >= cutoff,
        );
      },
    }),
    {
      name: "ptn-delay-reports",
    },
  ),
);
