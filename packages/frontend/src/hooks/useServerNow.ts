import { useEffect, useState } from "react";
import { serverTime } from "../services/serverTime.ts";

/**
 * Server-synced "now", re-read every `intervalMs` — the clock behind the map's
 * departure countdowns (`useCountdown`), for surfaces that need the time
 * itself: a leave time that comes due, a bus only a run still makes.
 *
 * `running: false` holds the last reading; switching back on re-reads at once.
 */
export function useServerNow(intervalMs: number, running = true): number {
  const [now, setNow] = useState(() => serverTime.now());

  useEffect(() => {
    if (!running) return;
    setNow(serverTime.now());
    const id = setInterval(() => setNow(serverTime.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, running]);

  return now;
}
