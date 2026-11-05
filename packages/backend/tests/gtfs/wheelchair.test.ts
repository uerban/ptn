import { describe, it, expect } from "vitest";
import {
  parseStops,
  parseTrips,
} from "../../src/gtfs/parser.js";

const encode = (csv: string) => new TextEncoder().encode(csv);

describe("GTFS wheelchair accessibility parsing and export", () => {
  it("parses wheelchair fields from GTFS CSV inputs", async () => {
    const stops = await parseStops(encode(`stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding
stop-1,Stop 1,54.0,25.0,1
stop-2,Stop 2,54.1,25.1,2
`));
    const trips = await parseTrips(encode(`trip_id,route_id,service_id,trip_headsign,wheelchair_accessible
trip-1,route-1,service-1,Destination,1
trip-2,route-1,service-1,Destination,2
`));

    expect(stops.map((stop) => [stop.id, stop.wheelchairBoarding])).toEqual([
      ["stop-1", 1],
      ["stop-2", 2],
    ]);
    expect(trips.map((trip) => [trip.tripId, trip.wheelchairAccessible])).toEqual([
      ["trip-1", 1],
      ["trip-2", 2],
    ]);
  });

});
