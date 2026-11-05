import { describe, it, expect } from "vitest";
import {
  parseStops,
  parseRoutes,
  parseTrips,
  parseStopTimes,
  parseCalendar,
  parseCalendarDates,
  parseTransfers,
  parseFrequencies,
  parseAgency,
  parseTimeToSecs,
  secsToGtfsTime,
} from "../../src/gtfs/parser.js";

const encode = (s: string) => new TextEncoder().encode(s);

describe("parseStops", () => {
  it("parses stops.txt CSV into GtfsStop objects", async () => {
    const csv = `stop_id,stop_name,stop_lat,stop_lon,parent_station
S1,Central Station,52.5200,13.4050,
S2,North Platform,52.5250,13.4100,S1
`;
    const stops = await parseStops(encode(csv));
    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual({
      id: "S1",
      name: "Central Station",
      lat: 52.52,
      lon: 13.405,
      parentStation: "",
    });
    expect(stops[1]).toEqual({
      id: "S2",
      name: "North Platform",
      lat: 52.525,
      lon: 13.41,
      parentStation: "S1",
    });
  });

  it("strips BOM from CSV", async () => {
    const csv = `\uFEFFstop_id,stop_name,stop_lat,stop_lon,parent_station\nS1,Main,52.0,13.0,\n`;
    const stops = await parseStops(encode(csv));
    expect(stops).toHaveLength(1);
    expect(stops[0].id).toBe("S1");
  });
});

describe("parseRoutes", () => {
  it("parses routes.txt CSV into GtfsRoute objects with correct TransportMode", async () => {
    const csv = `route_id,route_short_name,route_long_name,route_type,route_color,route_text_color
R1,U1,Underground Line 1,1,FF0000,FFFFFF
R2,B42,Bus Line 42,3,0000FF,FFFFFF
R3,T1,Tram Line 1,0,00FF00,000000
R4,RE1,Regional Express,2,FFFF00,000000
R5,F1,Ferry Line,4,00FFFF,000000
`;
    const routes = await parseRoutes(encode(csv));
    expect(routes).toHaveLength(5);
    expect(routes[0]).toEqual({
      id: "R1",
      shortName: "U1",
      longName: "Underground Line 1",
      mode: "METRO",
      color: "FF0000",
      textColor: "FFFFFF",
    });
    expect(routes[1].mode).toBe("BUS");
    expect(routes[2].mode).toBe("TRAM");
    expect(routes[3].mode).toBe("RAIL");
    expect(routes[4].mode).toBe("FERRY");
  });

  it("maps extended GTFS route types correctly", async () => {
    const csv = `route_id,route_short_name,route_long_name,route_type,route_color,route_text_color
R1,S1,S-Bahn,100,FFFFFF,000000
R2,U1,U-Bahn,400,FFFFFF,000000
R3,B1,Bus,700,FFFFFF,000000
R4,TR,Tram,900,FFFFFF,000000
R5,CC,Cable Car,5,FFFFFF,000000
R6,FU,Funicular,7,FFFFFF,000000
R7,UN,Unknown,999,FFFFFF,000000
R8,CC2,Cable Car 2,6,FFFFFF,000000
R9,TB,Trolleybus,11,FFFFFF,000000
R10,RE2,Regional 2,109,FFFFFF,000000
R11,TB2,Trolleybus 2,800,FFFFFF,000000
`;
    const routes = await parseRoutes(encode(csv));
    expect(routes[0].mode).toBe("RAIL");   // 100
    expect(routes[1].mode).toBe("METRO");  // 400
    expect(routes[2].mode).toBe("BUS");    // 700
    expect(routes[3].mode).toBe("TRAM");   // 900
    expect(routes[4].mode).toBe("CABLE_TRAM"); // 5
    expect(routes[5].mode).toBe("FUNICULAR"); // 7
    expect(routes[6].mode).toBe("TRAM");    // 999 → 900–999 tram band
    expect(routes[7].mode).toBe("AERIAL"); // 6
    expect(routes[8].mode).toBe("TROLLEYBUS");  // 11 (trolleybus)
    expect(routes[9].mode).toBe("RAIL");        // 109
    expect(routes[10].mode).toBe("TROLLEYBUS"); // 800 (trolleybus)
  });
});

describe("parseTrips", () => {
  it("parses trips.txt CSV into GtfsTrip objects", async () => {
    const csv = `trip_id,route_id,service_id,trip_headsign
T1,R1,WD,Destination A
T2,R1,WE,Destination B
`;
    const trips = await parseTrips(encode(csv));
    expect(trips).toHaveLength(2);
    expect(trips[0]).toEqual({
      tripId: "T1",
      routeId: "R1",
      serviceId: "WD",
      headsign: "Destination A",
    });
    expect(trips[1]).toEqual({
      tripId: "T2",
      routeId: "R1",
      serviceId: "WE",
      headsign: "Destination B",
    });
  });

  it("parseTrips picks up optional shape_id (undefined when absent)", async () => {
    const withShape = new TextEncoder().encode(
      "trip_id,route_id,service_id,trip_headsign,shape_id\nT1,R1,S1,Centre,SHP1\n",
    );
    const withoutShape = new TextEncoder().encode(
      "trip_id,route_id,service_id,trip_headsign\nT2,R1,S1,Centre\n",
    );
    const a = await parseTrips(withShape);
    const b = await parseTrips(withoutShape);
    expect(a[0].shapeId).toBe("SHP1");
    expect(b[0].shapeId).toBeUndefined();
  });

  it("parseTrips picks up optional direction_id (undefined when absent)", async () => {
    const withDir = new TextEncoder().encode(
      "trip_id,route_id,service_id,trip_headsign,direction_id\nT1,R1,S1,Outbound,0\nT2,R1,S1,Inbound,1\n",
    );
    const withoutDir = new TextEncoder().encode(
      "trip_id,route_id,service_id,trip_headsign\nT3,R1,S1,Centre\n",
    );
    const malformed = new TextEncoder().encode(
      "trip_id,route_id,service_id,trip_headsign,direction_id\nT4,R1,S1,Centre,2\n",
    );
    const a = await parseTrips(withDir);
    const b = await parseTrips(withoutDir);
    const c = await parseTrips(malformed);
    expect(a[0].directionId).toBe(0);
    expect(a[1].directionId).toBe(1);
    expect(b[0].directionId).toBeUndefined();
    // Out-of-spec values are dropped rather than coerced; downstream falls
    // back to headsign-based grouping for these trips.
    expect(c[0].directionId).toBeUndefined();
  });
});

describe("parseStopTimes", () => {
  it("parses stop_times.txt CSV into GtfsStopTime objects", async () => {
    const csv = `trip_id,stop_id,departure_time,stop_sequence
T1,S1,08:00:00,1
T1,S2,08:05:00,2
T1,S3,08:12:00,3
`;
    const stopTimes = await parseStopTimes(encode(csv));
    expect(stopTimes).toHaveLength(3);
    expect(stopTimes[0]).toEqual({
      tripId: "T1",
      stopId: "S1",
      departureTime: "08:00:00",
      stopSequence: 1,
    });
    expect(stopTimes[2].stopSequence).toBe(3);
    expect(typeof stopTimes[0].stopSequence).toBe("number");
  });

  it("reads pickup_type / drop_off_type, omitting defaults", async () => {
    const csv =
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n" +
      "t1,08:00:00,08:00:00,a,1,1,0\n" +
      "t1,08:10:00,08:10:00,b,2,,3\n";
    const st = await parseStopTimes(encode(csv));
    expect(st[0].pickupType).toBe(1);
    expect(st[0].dropOffType).toBeUndefined(); // "0" → undefined
    expect(st[1].pickupType).toBeUndefined(); // "" → undefined
    expect(st[1].dropOffType).toBe(3);
  });
});

describe("parseCalendar", () => {
  it("returns empty array for empty input", async () => {
    const result = await parseCalendar(new Uint8Array(0));
    expect(result).toEqual([]);
  });

  it("parses calendar.txt CSV into GtfsService objects with boolean day fields", async () => {
    const csv = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WD,1,1,1,1,1,0,0,20240101,20241231
WE,0,0,0,0,0,1,1,20240101,20241231
`;
    const services = await parseCalendar(encode(csv));
    expect(services).toHaveLength(2);
    expect(services[0]).toEqual({
      serviceId: "WD",
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startDate: "20240101",
      endDate: "20241231",
    });
    expect(services[1].monday).toBe(false);
    expect(services[1].saturday).toBe(true);
    expect(services[1].sunday).toBe(true);
    expect(typeof services[0].monday).toBe("boolean");
  });
});

describe("parseCalendarDates", () => {
  it("returns empty array for empty input", async () => {
    const result = await parseCalendarDates(new Uint8Array(0));
    expect(result).toEqual([]);
  });

  it("parses calendar_dates.txt CSV into GtfsCalendarDate objects", async () => {
    const csv = `service_id,date,exception_type
WD,20240325,1
WD,20240401,2
`;
    const calendarDates = await parseCalendarDates(encode(csv));
    expect(calendarDates).toHaveLength(2);
    expect(calendarDates[0]).toEqual({
      serviceId: "WD",
      date: "20240325",
      exceptionType: 1,
    });
    expect(calendarDates[1].exceptionType).toBe(2);
    expect(typeof calendarDates[0].exceptionType).toBe("number");
  });
});

describe("secsToGtfsTime", () => {
  it("serializes without modulo (overnight-safe) and round-trips", () => {
    expect(secsToGtfsTime(0)).toBe("00:00:00");
    expect(secsToGtfsTime(8 * 3600)).toBe("08:00:00");
    expect(secsToGtfsTime(90000)).toBe("25:00:00"); // no % 24
    expect(secsToGtfsTime(86400)).toBe("24:00:00");
    for (const x of [0, 59, 3600, 86399, 86400, 90000, 91800, 100000]) {
      expect(parseTimeToSecs(secsToGtfsTime(x))).toBe(x);
    }
  });
  it("throws on negative or non-integer", () => {
    expect(() => secsToGtfsTime(-1)).toThrow();
    expect(() => secsToGtfsTime(1.5)).toThrow();
  });
});

describe("parseFrequencies", () => {
  it("parses rows; exact_times defaults to 0; empty -> []", async () => {
    expect(await parseFrequencies(new Uint8Array())).toEqual([]);
    const csv =
      "trip_id,start_time,end_time,headway_secs,exact_times\n" +
      "t1,08:00:00,08:30:00,600,1\n" +
      "t2,23:50:00,24:10:00,600,\n"; // blank exact_times -> 0
    const f = await parseFrequencies(encode(csv));
    expect(f[0]).toEqual({ tripId: "t1", startSecs: 28800, endSecs: 30600, headwaySecs: 600, exactTimes: 1 });
    expect(f[1]).toEqual({ tripId: "t2", startSecs: 85800, endSecs: 87000, headwaySecs: 600, exactTimes: 0 });
  });
});

describe("parseRoutes agency_id", () => {
  it("reads agency_id; omits when absent", async () => {
    const r = await parseRoutes(encode(
      "route_id,agency_id,route_short_name,route_long_name,route_type\n" +
      "r1,EXA,R1,Route 1,3\n" +
      "r2,,R2,Route 2,3\n"));
    expect(r[0].agencyId).toBe("EXA");
    expect(r[1].agencyId).toBeUndefined();
  });
});

describe("parseAgency 8 fields", () => {
  it("reads url/lang/phone/fare_url/email; omits absent", async () => {
    const a = await parseAgency(encode(
      "agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone,agency_fare_url,agency_email\n" +
      "EXA,Example Transit Co,https://exa.invalid,UTC,en,+00,https://exa.invalid/fares,ops@exa.invalid\n" +
      "BARE,Bare Co,,UTC,,,,\n"));
    expect(a[0]).toEqual({ agencyId: "EXA", agencyName: "Example Transit Co", agencyTimezone: "UTC", url: "https://exa.invalid", lang: "en", phone: "+00", fareUrl: "https://exa.invalid/fares", email: "ops@exa.invalid" });
    expect(a[1]).toEqual({ agencyId: "BARE", agencyName: "Bare Co", agencyTimezone: "UTC" }); // absent → undefined → omitted
  });
});
