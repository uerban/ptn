import { useState, useEffect, useCallback } from "react";

interface DeviceHeadingState {
  heading: number | null;
  permissionState: "prompt" | "granted" | "denied" | "unsupported";
}

/**
 * Device compass heading using DeviceOrientationEvent.
 * Handles iOS permission request (DeviceOrientationEvent.requestPermission).
 * Falls back to null heading when unsupported.
 */
export function useDeviceHeading(enabled: boolean): DeviceHeadingState & {
  requestPermission: () => Promise<void>;
} {
  const [state, setState] = useState<DeviceHeadingState>({
    heading: null,
    permissionState: "prompt",
  });

  const requestPermission = useCallback(async () => {
    // iOS 13+ requires explicit permission
    const DevOrientation = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof DevOrientation.requestPermission === "function") {
      try {
        const result = await DevOrientation.requestPermission();
        setState((prev) => ({
          ...prev,
          permissionState: result,
        }));
      } catch {
        setState((prev) => ({ ...prev, permissionState: "denied" }));
      }
    } else if ("DeviceOrientationEvent" in window) {
      setState((prev) => ({ ...prev, permissionState: "granted" }));
    } else {
      setState((prev) => ({ ...prev, permissionState: "unsupported" }));
    }
  }, []);

  useEffect(() => {
    if (!enabled || state.permissionState !== "granted") return;

    // deviceorientation fires at up to ~60 Hz; a setState per event re-renders
    // every consumer at sensor rate. Gate on whole-degree changes and cap at
    // ~10 Hz — sub-degree jitter is invisible at map-arrow scale.
    const MIN_UPDATE_INTERVAL_MS = 100;
    let lastAppliedDegree: number | null = null;
    let lastAppliedAtMs = 0;

    const handler = (event: DeviceOrientationEvent) => {
      // webkitCompassHeading is iOS-specific (degrees from north)
      const webkit = (event as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading;
      const alpha = event.alpha;

      let heading: number | null = null;
      if (webkit !== undefined && webkit !== null) {
        heading = webkit;
      } else if (alpha !== null && alpha !== undefined) {
        // On Android, alpha is degrees from north (0-360), but reversed
        heading = (360 - alpha) % 360;
      }

      if (heading !== null) {
        const degree = Math.round(heading) % 360;
        const nowMs = Date.now();
        if (
          degree === lastAppliedDegree ||
          nowMs - lastAppliedAtMs < MIN_UPDATE_INTERVAL_MS
        ) {
          return;
        }
        lastAppliedDegree = degree;
        lastAppliedAtMs = nowMs;
        setState((prev) => ({ ...prev, heading }));
      }
    };

    window.addEventListener("deviceorientation", handler);
    return () => window.removeEventListener("deviceorientation", handler);
  }, [enabled, state.permissionState]);

  // Auto-request permission on mount when enabled (non-iOS)
  useEffect(() => {
    if (!enabled) return;
    if (state.permissionState === "prompt") {
      const DevOrientation = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      if (typeof DevOrientation.requestPermission !== "function") {
        // Non-iOS: auto-grant
        if ("DeviceOrientationEvent" in window) {
          setState((prev) => ({ ...prev, permissionState: "granted" }));
        } else {
          setState((prev) => ({ ...prev, permissionState: "unsupported" }));
        }
      }
    }
  }, [enabled, state.permissionState]);

  return { ...state, requestPermission };
}
