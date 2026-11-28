import { useMemo } from "react";
import type { Departure, Leg, ServiceNotice } from "@pt/shared";
import { useCityStore } from "../stores/cityStore.ts";
import { useCityDataStore } from "./cityData.ts";
import { useCityNotices } from "./serviceNoticesStore.ts";
import { noticesForDeparture, noticesForLeg, resolveNoticeTrips, type NoticeTrips } from "./notices.ts";

const EMPTY: ServiceNotice[] = [];
const resolved = new WeakMap<readonly ServiceNotice[], { wire: unknown; trips: NoticeTrips }>();

/** The active city's notices and their trip resolution against the loaded bundle. */
export function useActiveNotices(): { notices: readonly ServiceNotice[]; trips: NoticeTrips } {
  const city = useCityStore((s) => s.activeCity);
  const notices = useCityNotices(city.id);
  const wire = useCityDataStore((s) => s.active?.wire);
  return useMemo(() => {
    if (!notices.length) return { notices: EMPTY, trips: new Map() };
    const cached = resolved.get(notices);
    if (cached && cached.wire === wire) return { notices, trips: cached.trips };
    const trips = wire && notices.some((n) => n.trips)
      ? resolveNoticeTrips(notices, wire.routes, wire.calendar, city.tz)
      : new Map();
    resolved.set(notices, { wire, trips });
    return { notices, trips };
  }, [notices, wire, city.tz]);
}

export function useLegNotices(leg: Leg): ServiceNotice[] {
  const { notices, trips } = useActiveNotices();
  return useMemo(() => (notices.length ? noticesForLeg(notices, leg, trips) : EMPTY), [notices, trips, leg]);
}

export function useDepartureNotices(departure: Departure): ServiceNotice[] {
  const { notices, trips } = useActiveNotices();
  return useMemo(() => (notices.length ? noticesForDeparture(notices, departure, trips) : EMPTY), [notices, trips, departure]);
}
