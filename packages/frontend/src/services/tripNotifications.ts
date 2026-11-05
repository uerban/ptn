/**
 * Trip notification service — sends browser notifications for trip events
 * when the app tab is backgrounded. Uses the Web Notification API (not push).
 */

/** Request notification permission. Returns true if granted. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;

  try {
    return await Notification.requestPermission() === "granted";
  } catch {
    return false;
  }
}

/** Send a notification only when the document is NOT visible (tab backgrounded). */
export async function notifyIfBackground(title: string, body: string): Promise<boolean> {
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden" &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    const options = { body, icon: "/favicon.svg", tag: "ptn-trip" };
    try {
      // Android and iOS PWAs require persistent service-worker notifications.
      // https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) await registration.showNotification(title, options);
      else new Notification(title, options); // Desktop without an installed worker.
      return true;
    } catch {
      // Unsupported or revoked permissions must never break guidance.
      return false;
    }
  }
  return false;
}

/** Trip notification event types for duplicate tracking. */
export type TripNotificationEvent =
  | "started"
  | `transfer-${number}`
  | `getoff-${number}`;
