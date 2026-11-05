import { reportError } from "./errorReporter.ts";

// Magnitude filter on the local-vs-server time delta. Original motivation
// was service-worker cached responses carrying days-old `Date` headers;
// that vector is now mitigated at the call site — `useServerTimeSync`
// only sources `Date` from the `NetworkOnly` `/version` route — so the
// SW-cache path no longer reaches `update()` at all. This filter remains
// as defence-in-depth against the other sources: genuine device-clock
// drift, manually-set device clocks, captive-portal date headers,
// backend NTP drift, or a future regression that re-introduces a
// cache-touching sync path. The threshold can't distinguish those —
// telemetry below makes the rejection observable so a real >5min skew
// (which still leaves users on uncorrected local time) doesn't silently
// fail.
const MAX_PLAUSIBLE_OFFSET_MS = 5 * 60 * 1000;

export class ServerTimeSyncer {
  private offsetMs = 0;
  private synced = false;

  update(serverIso: string): void {
    const serverMs = new Date(serverIso).getTime();
    if (isNaN(serverMs)) {
      console.warn("Invalid server time received:", serverIso);
      return;
    }
    const offset = serverMs - Date.now();
    if (Math.abs(offset) > MAX_PLAUSIBLE_OFFSET_MS) {
      reportError(
        new Error(
          `[serverTime] implausible offset ${Math.round(offset / 1000)}s — rejected; falling back to client time`,
        ),
        {
          context: {
            where: "serverTime.implausibleOffset",
            offsetMs: offset,
            serverIso,
            previouslySynced: this.synced,
          },
        },
      );
      return;
    }
    this.offsetMs = offset;
    this.synced = true;
  }

  now(): number {
    return Date.now() + (this.synced ? this.offsetMs : 0);
  }
}

export const serverTime = new ServerTimeSyncer();
