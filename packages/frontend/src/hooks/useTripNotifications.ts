import { useEffect, useRef } from "react";
import type { Itinerary } from "@pt/shared";
import { useGuidanceStore } from "../stores/guidanceStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import {
  notifyIfBackground,
  type TripNotificationEvent,
} from "../services/tripNotifications.ts";
import { useTranslation } from "../i18n/index.ts";

/**
 * Hook that watches guidance store phase + transit progress and fires
 * browser notifications at key trip events when the tab is backgrounded.
 *
 * Tracks what has been notified via a ref-based Set to avoid duplicates.
 * Resets when navigation stops (phase goes idle).
 */
export function useTripNotifications(): void {
  const { t } = useTranslation();

  const phase = useGuidanceStore((s) => s.phase);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const transitProgress = useGuidanceStore((s) => s.transitProgress);
  const notificationsEnabled = useSettingsStore((s) => s.tripNotificationsEnabled);
  const completedItinerary = useGuidanceStore((s) => s.completedItinerary);

  const firedRef = useRef<Set<TripNotificationEvent>>(new Set());
  const prevPhaseRef = useRef(phase);

  // Reset fired set when navigation stops
  useEffect(() => {
    if (prevPhaseRef.current !== "idle" && phase === "idle") {
      firedRef.current.clear();
    }
    prevPhaseRef.current = phase;
  }, [phase]);

  // Trip started notification
  useEffect(() => {
    if (!notificationsEnabled || phase !== "navigating" || !itinerary) return;
    if (firedRef.current.has("started")) return;

    const lastLeg = itinerary.legs[itinerary.legs.length - 1];
    const destination = lastLeg?.to.name ?? "";

    firedRef.current.add("started");
    notifyIfBackground(
      t("notif.trip_started", "Navigation started"),
      t("notif.trip_started_body", "Navigation started — {destination}").replace(
        "{destination}",
        destination,
      ),
    );
  }, [phase, itinerary, notificationsEnabled, t]);

  // Approaching transfer notification (2 stops remaining on current leg, next leg is transit)
  useEffect(() => {
    if (!notificationsEnabled || phase !== "navigating" || !itinerary) return;
    if (!transitProgress || transitProgress.stopsRemaining !== 2) return;

    const eventKey: TripNotificationEvent = `transfer-${currentLegIndex}`;
    if (firedRef.current.has(eventKey)) return;

    // Check if there is a next leg and it's a transit leg
    const nextLeg = itinerary.legs[currentLegIndex + 1];
    if (!nextLeg || nextLeg.mode === "WALK" || nextLeg.mode === "BIKE" || nextLeg.mode === "SCOOTER") return;

    const nextLine = nextLeg.routeShortName ?? nextLeg.mode;
    firedRef.current.add(eventKey);
    notifyIfBackground(
      t("notif.transfer_approaching", "Transfer coming up"),
      t("notif.transfer_approaching_body", "Transfer in {n} stops — get ready for {nextLine}")
        .replace("{n}", String(transitProgress.stopsRemaining))
        .replace("{nextLine}", nextLine),
    );
  }, [phase, itinerary, currentLegIndex, transitProgress, notificationsEnabled, t]);

  // Get-off alert (1 stop remaining)
  useEffect(() => {
    if (!notificationsEnabled || phase !== "navigating" || !itinerary) return;
    if (!transitProgress || transitProgress.stopsRemaining !== 1) return;

    const eventKey: TripNotificationEvent = `getoff-${currentLegIndex}`;
    if (firedRef.current.has(eventKey)) return;

    const currentLeg = itinerary.legs[currentLegIndex];
    const stopName = currentLeg?.to.name ?? "";

    firedRef.current.add(eventKey);
    notifyIfBackground(
      t("notif.getoff_alert", "Your stop is next"),
      t("notif.getoff_alert_body", "Your stop is next: {stopName}").replace(
        "{stopName}",
        stopName,
      ),
    );
  }, [phase, itinerary, currentLegIndex, transitProgress, notificationsEnabled, t]);

  // Trip complete notification — the store hands over the itinerary it just
  // finished (a manual stop leaves this null). Reading the idle transition
  // instead never fired: the reset effect above has already moved
  // prevPhaseRef on, and the itinerary is gone by then.
  const announcedArrivalRef = useRef<Itinerary | null>(null);
  useEffect(() => {
    if (!notificationsEnabled || !completedItinerary) return;
    if (announcedArrivalRef.current === completedItinerary) return;
    announcedArrivalRef.current = completedItinerary;

    const lastLeg = completedItinerary.legs[completedItinerary.legs.length - 1];
    const destination = lastLeg?.to.name ?? "";

    notifyIfBackground(
      t("notif.trip_complete", "You've arrived"),
      t("notif.trip_complete_body", "You've arrived at {destination}").replace(
        "{destination}",
        destination,
      ),
    );
  }, [completedItinerary, notificationsEnabled, t]);
}
