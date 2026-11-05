import { useRef, useEffect, useCallback, useState } from "react";
import type { GuidancePhase } from "@pt/shared";

export interface GetOffAlarmState {
  /** "next" = one stop away, "arrived" = at destination, null = no alarm */
  level: "next" | "arrived" | null;
  /** Name of the stop to get off at */
  stopName: string | null;
}

/**
 * Determines whether a get-off alarm should fire based on stops remaining
 * and current guidance phase. Triggers vibration and returns visual state.
 *
 * Fires exactly once per threshold crossing. Resets when phase becomes "idle"
 * or when currentLegIndex changes.
 */
export function useGetOffAlarm(
  stopsRemaining: number | null,
  /** The current leg's alighting stop — what "your stop" names. */
  alightingStopName: string | null,
  phase: GuidancePhase,
  enabled: boolean,
  currentLegIndex: number,
): GetOffAlarmState {
  // Track which thresholds have already fired to avoid repeat triggers
  const firedRef = useRef<Set<"next" | "arrived">>(new Set());
  // State, not a ref: the alarm is set in an effect, and only a state update
  // re-renders the banner — a ref showed up a render late, whenever something
  // unrelated happened to re-render the caller.
  const [alarmState, setAlarmState] = useState<GetOffAlarmState>({ level: null, stopName: null });

  // Reset when phase goes idle or leg changes
  useEffect(() => {
    firedRef.current.clear();
    setAlarmState({ level: null, stopName: null });
  }, [phase === "idle" ? "idle" : "active", currentLegIndex]);

  const vibrate = useCallback((pattern: number[]) => {
    try {
      if (navigator.vibrate) {
        navigator.vibrate(pattern);
      }
    } catch {
      // Vibration API not available or blocked — silently ignore
    }
  }, []);

  useEffect(() => {
    if (!enabled || phase !== "navigating" || stopsRemaining === null) return;

    if (stopsRemaining === 0 && !firedRef.current.has("arrived")) {
      firedRef.current.add("arrived");
      setAlarmState({ level: "arrived", stopName: alightingStopName });
      vibrate([400, 200, 400, 200, 400]);
    } else if (stopsRemaining === 1 && !firedRef.current.has("next")) {
      firedRef.current.add("next");
      setAlarmState({ level: "next", stopName: alightingStopName });
      vibrate([200, 100, 200]);
    }
  }, [stopsRemaining, alightingStopName, phase, enabled, vibrate]);

  if (!enabled || phase !== "navigating" || stopsRemaining === null) {
    return { level: null, stopName: null };
  }

  return alarmState;
}

/**
 * Pure function for testing: determines alarm state without side-effects.
 */
export function computeAlarmLevel(
  stopsRemaining: number | null,
  phase: GuidancePhase,
  enabled: boolean,
): "next" | "arrived" | null {
  if (!enabled || phase !== "navigating" || stopsRemaining === null) return null;
  if (stopsRemaining === 0) return "arrived";
  if (stopsRemaining === 1) return "next";
  return null;
}
