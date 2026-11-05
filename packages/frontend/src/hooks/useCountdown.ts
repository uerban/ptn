import { useState, useEffect, useRef, useMemo } from "react";
import { COUNTDOWN_INTERVAL_MS } from "@pt/shared/constants";
import { serverTime } from "../services/serverTime.ts";

/** Returns minutes until each timestamp (negative = departed). Updates every second. */
export function useCountdown(timestamps: string[]): number[] {
  const timestampsRef = useRef(timestamps);
  timestampsRef.current = timestamps;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (timestamps.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), COUNTDOWN_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [timestamps.length]);

  const timestampsKey = JSON.stringify(timestamps);
  // Compute synchronously during render so the first paint is never stale.
  // Recomputes when timestamps change (via timestampsKey) or on each interval tick.
  return useMemo(() => computeMinutes(timestampsRef.current), [timestampsKey, tick]);
}

/**
 * Minutes from `now` until `time` (both epoch ms), rounded up: the countdown
 * every departure surface shows (≤ 0 reads "Due", negative = departed).
 */
export function minutesUntil(time: number, now: number): number {
  return Math.ceil((time - now) / 60_000);
}

function computeMinutes(timestamps: string[]): number[] {
  const now = serverTime.now();
  return timestamps.map((ts) => minutesUntil(new Date(ts).getTime(), now));
}
