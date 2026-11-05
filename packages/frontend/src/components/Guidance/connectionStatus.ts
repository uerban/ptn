import type { Leg } from "@pt/shared";

export type ConnectionSafety = "safe" | "atRisk" | "extraTime";

export interface ConnectionStatus {
  safety: ConnectionSafety;
  message: string;
}

type Translate = (key: string, fallback?: string) => string;

/** Identity translator: renders the English fallback, as the call sites did
 *  before this function took a translator at all. */
const EN: Translate = (key, fallback) => fallback ?? key;

function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(`{${k}}`).join(String(v)),
    template,
  );
}

/**
 * Compute whether the connection between the current leg and the next transit leg
 * is safe, at risk, or has extra time, using RT delay data.
 *
 * @param currentLeg - The leg currently being traveled
 * @param nextTransitLeg - The next transit leg to connect to
 * @param rtStore - RT store for live delay lookups
 * @param t - translator; omitted, the message renders in English
 */
export function computeConnectionStatus(
  currentLeg: Leg,
  nextTransitLeg: Leg,
  rtStore: { getTripDelay: (tripId: string) => { delaySeconds: number; cancelled: boolean; deleted?: boolean } | null },
  t: Translate = EN,
): ConnectionStatus | null {
  if (!currentLeg.tripId || !nextTransitLeg.tripId) return null;

  const nextName = `${nextTransitLeg.routeShortName ?? nextTransitLeg.mode}`;
  // A connection that is not running outranks every timing question — its
  // delay would otherwise read as "extra time". DELETED is said neutrally,
  // never as a cancellation.
  const nextRt = rtStore.getTripDelay(nextTransitLeg.tripId);
  if (nextRt?.deleted) {
    return {
      safety: "atRisk",
      message: fill(t("guidance.connection_removed", "Connection no longer scheduled — {line}"), {
        line: nextName,
      }),
    };
  }
  if (nextRt?.cancelled) {
    return {
      safety: "atRisk",
      message: fill(
        t("guidance.connection_cancelled", "Connection cancelled — {line} is not running"),
        { line: nextName },
      ),
    };
  }

  const currentDelay = rtStore.getTripDelay(currentLeg.tripId)?.delaySeconds ?? 0;
  const nextDelay = rtStore.getTripDelay(nextTransitLeg.tripId)?.delaySeconds ?? 0;

  const currentArrival = new Date(currentLeg.arrivalTime).getTime() + currentDelay * 1000;
  const nextDeparture = new Date(nextTransitLeg.departureTime).getTime() + nextDelay * 1000;
  const bufferSeconds = Math.round((nextDeparture - currentArrival) / 1000);

  const delayMin = Math.abs(Math.round(nextDelay / 60));

  if (bufferSeconds < 0) {
    return {
      safety: "atRisk",
      message: fill(
        t(
          "guidance.connection_at_risk",
          "Connection at risk — {line} departing {when}",
        ),
        {
          line: nextName,
          when:
            delayMin > 0
              ? fill(t("guidance.connection_min_earlier", "{n} min earlier"), {
                  n: delayMin,
                })
              : t("guidance.connection_now", "now"),
        },
      ),
    };
  } else if (bufferSeconds < 120) {
    return {
      safety: "atRisk",
      message: fill(
        t(
          "guidance.connection_tight",
          "Tight connection — {n}s buffer for {line}",
        ),
        { n: bufferSeconds, line: nextName },
      ),
    };
  } else if (nextDelay > 30) {
    return {
      safety: "extraTime",
      message: fill(
        t(
          "guidance.connection_extra_time",
          "{line} running {n} min late — you have extra time",
        ),
        { line: nextName, n: delayMin },
      ),
    };
  }

  return {
    safety: "safe",
    message: fill(
      t("guidance.connection_safe", "Connection safe — {n} min buffer"),
      { n: Math.round(bufferSeconds / 60) },
    ),
  };
}
