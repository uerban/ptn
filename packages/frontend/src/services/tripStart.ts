/**
 * Starting trip guidance, and which browser permission requests that start
 * would cause: location (guidance progress) and notifications (get-off
 * alerts, when enabled). The trip-start explanation is shown only when one
 * of them would actually prompt.
 */
import type { Itinerary } from "@pt/shared";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { liveLocation } from "./liveLocation.ts";
import { requestNotificationPermission } from "./tripNotifications.ts";

export interface TripStartPrompts {
  /** Starting would ask for location permission. */
  location: boolean;
  /** Starting would ask for notification permission. */
  notifications: boolean;
}

export interface TripStartEnvironment {
  geolocationPermission: () => Promise<PermissionState | null>;
  notificationPermission: () => NotificationPermission | null;
  hasPosition: () => boolean;
}

const browserEnvironment: TripStartEnvironment = {
  geolocationPermission: async () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return null;
    try {
      return (await navigator.permissions.query({ name: "geolocation" })).state;
    } catch {
      // Older Safari cannot say. Unknown is treated as "would ask".
      return "prompt";
    }
  },
  notificationPermission: () =>
    typeof Notification === "undefined" ? null : Notification.permission,
  hasPosition: () => liveLocation.getSnapshot().position !== null,
};

export async function pendingTripStartPrompts(
  env: TripStartEnvironment = browserEnvironment,
): Promise<TripStartPrompts> {
  const { gpsMode, tripNotificationsEnabled } = useSettingsStore.getState();
  // Guidance asks for location only while GPS is on (`liveLocation.request`).
  const location =
    gpsMode === "enabled" &&
    !env.hasPosition() &&
    (await env.geolocationPermission()) === "prompt";
  const notifications =
    tripNotificationsEnabled && env.notificationPermission() === "default";
  return { location, notifications };
}

/** Start guidance, asking for what it uses. Call from the user's action. */
export function beginTrip(itinerary: Itinerary): void {
  liveLocation.request("navigation");
  if (useSettingsStore.getState().tripNotificationsEnabled) void requestNotificationPermission();
  useGuidanceStore.getState().startNavigation(itinerary);
}
