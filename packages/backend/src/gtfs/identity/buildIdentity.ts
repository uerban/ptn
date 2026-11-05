import { readCaps } from "../caps.js";
import { createInternTableBuilder } from "./InternTableBuilder.js";
import { buildServiceBitmasks } from "./ServiceBitmaskBuilder.js";
import { buildCappedTripStringTable } from "../parser.js";
import type { GtfsStop, GtfsRoute, GtfsTrip, GtfsService, GtfsCalendarDate } from "../parser.js";
import type { Identity } from "./types.js";

export interface BuildIdentityInput {
  stops: GtfsStop[];
  routes: GtfsRoute[];
  trips: GtfsTrip[];
  services: GtfsService[];
  calendarDates: GtfsCalendarDate[];
  /** ISO date (YYYY-MM-DD) that Identity is built relative to. */
  buildDateIso: string;
  /** Horizon in days covered by ServiceBitmask. */
  horizonDays: number;
}

export function buildIdentity(input: BuildIdentityInput): Identity {
  const caps = readCaps();

  const stopsBuilder = createInternTableBuilder<string>({ cap: caps.stops, label: "stops" });
  for (const s of input.stops) stopsBuilder.intern(s.id);

  const routesBuilder = createInternTableBuilder<string>({ cap: caps.routes, label: "routes" });
  for (const r of input.routes) routesBuilder.intern(r.id);

  const servicesBuilder = createInternTableBuilder<string>({ cap: caps.services, label: "services" });
  const serviceIdSet = new Set<string>();
  for (const s of input.services) serviceIdSet.add(s.serviceId);
  for (const cd of input.calendarDates) serviceIdSet.add(cd.serviceId);
  for (const sid of serviceIdSet) servicesBuilder.intern(sid);

  const headsignsBuilder = createInternTableBuilder<string>({ cap: caps.trips, label: "headsigns" });
  for (const t of input.trips) headsignsBuilder.intern(t.headsign);

  const tripStrings = buildCappedTripStringTable(input.trips.map((t) => t.tripId), caps.trips);

  const bitmasks = buildServiceBitmasks({
    services: input.services,
    exceptions: input.calendarDates,
    startDateIso: input.buildDateIso,
    horizonDays: input.horizonDays,
  });

  return {
    stops: stopsBuilder.freeze(),
    routes: routesBuilder.freeze(),
    services: servicesBuilder.freeze(),
    headsigns: headsignsBuilder.freeze(),
    trips: {
      get size(): number { return tripStrings.size; },
      indexOf: (s: string) => tripStrings.indexOf(s),
      valueAt: (ix: number) => tripStrings.stringAt(ix),
    },
    bitmasks,
    buildDateIso: input.buildDateIso,
    horizonDays: input.horizonDays,
  };
}
