import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OtpAdapter } from "../../src/adapters/otp.js";

// OTP /plan response — timestamps in milliseconds, wrapped in plan.itineraries
const PLAN_RESPONSE = {
  plan: {
    itineraries: [
      {
        duration: 1800,
        startTime: 1741471200000, // 2025-03-08T22:00:00Z
        endTime:   1741473000000, // 2025-03-08T22:30:00Z
        transfers: 1,
        legs: [
          {
            mode: "WALK",
            startTime: 1741471200000,
            endTime:   1741471500000, // +5 min
            duration: 300,
            distance: 400,
            from: { name: "Origin", lat: 54.68, lon: 25.28 },
            to:   { name: "Stop A", stopId: "stop:1", lat: 54.675, lon: 25.282 },
            legGeometry: { points: "poly_walk" },
          },
          {
            mode: "BUS",
            startTime: 1741471500000,
            endTime:   1741472700000, // +20 min
            duration: 1200,
            distance: 5000,
            from: { name: "Stop A", stopId: "stop:1", lat: 54.675, lon: 25.282 },
            to:   { name: "Stop B", stopId: "stop:2", lat: 54.650, lon: 25.270 },
            routeShortName: "42",
            routeColor: "ff0000",
            tripId: "trip:1",
            headsign: "City Center",
            intermediateStops: [
              { name: "Mid Stop", stopId: "stop:mid", lat: 54.66, lon: 25.275 },
            ],
            legGeometry: { points: "poly_bus" },
          },
          {
            mode: "WALK",
            startTime: 1741472700000,
            endTime:   1741473000000, // +5 min
            duration: 300,
            distance: 350,
            from: { name: "Stop B", stopId: "stop:2", lat: 54.650, lon: 25.270 },
            to:   { name: "Destination", lat: 54.645, lon: 25.265 },
            legGeometry: { points: "poly_walk2" },
          },
        ],
      },
    ],
  },
};

// OTP geocode response
const GEOCODE_RESPONSE = [
  { id: "stop:A", description: "Central Station", lat: 54.68, lon: 25.28 },
  { id: "stop:B", description: "Airport",         lat: 54.64, lon: 25.28 },
  { id: "stop:C", description: "Bus Terminal",    lat: 54.66, lon: 25.27 },
];

// OTP /index/stops response
const INDEX_STOPS_RESPONSE = [
  { id: "stop:near1", name: "Market Square", lat: 54.681, lon: 25.281 },
  { id: "stop:near2", name: "Cathedral",     lat: 54.679, lon: 25.283 },
];

// OTP stoptimes response
const STOPTIMES_RESPONSE = [
  {
    serviceDay: 1741392000, // seconds since epoch for start of service day
    scheduledDeparture: 3600,  // seconds into service day = 01:00
    realtimeDeparture: 3720,   // 2 min late
    realtime: true,
    headsign: "Airport",
    trip: {
      id: "trip:bus42",
      routeId: "route:42",
      shortName: "42",
      routeColor: "00aaff",
      mode: "BUS",
    },
  },
  {
    serviceDay: 1741392000,
    scheduledDeparture: 7200,  // 02:00
    realtimeDeparture: 7200,
    realtime: false,
    headsign: "Downtown",
    trip: {
      id: "trip:tram5",
      routeId: "route:5",
      shortName: "5",
      routeColor: "00cc00",
      mode: "TRAM",
    },
  },
];

describe("OtpAdapter", () => {
  const adapter = new OtpAdapter("http://otp.example.com");

  it("has correct name", () => {
    expect(adapter.name).toBe("otp");
  });

  it("implements RoutingAdapter interface", () => {
    expect(typeof adapter.planTrip).toBe("function");
    expect(typeof adapter.getNearbyStops).toBe("function");
    expect(typeof adapter.getDepartures).toBe("function");
    expect(typeof adapter.searchStops).toBe("function");
    expect(typeof adapter.getVehiclePositions).toBe("function");
    expect(typeof adapter.healthCheck).toBe("function");
  });

  it("getVehiclePositions returns empty array", async () => {
    const positions = await adapter.getVehiclePositions!({
      minLat: 54.6,
      minLon: 25.2,
      maxLat: 54.7,
      maxLon: 25.3,
    });
    expect(positions).toEqual([]);
  });

  describe("response mapping with mocked fetch", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    // --- planTrip ---

    it("planTrip maps plan.itineraries from OTP response", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.68, lon: 25.28 },
        to:   { lat: 54.645, lon: 25.265 },
      });

      expect(result.itineraries).toHaveLength(1);
      // No nextPageCursor for OTP v1
      expect(result.nextPageCursor).toBeUndefined();
    });

    it("planTrip converts millisecond timestamps to ISO 8601", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.68, lon: 25.28 },
        to:   { lat: 54.645, lon: 25.265 },
      });

      const itin = result.itineraries[0];
      expect(itin.departureTime).toBe("2025-03-08T22:00:00.000Z");
      expect(itin.arrivalTime).toBe("2025-03-08T22:30:00.000Z");
      expect(itin.durationSeconds).toBe(1800);
      expect(itin.transfers).toBe(1);
    });

    it("planTrip maps leg timestamps from milliseconds", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.68, lon: 25.28 },
        to:   { lat: 54.645, lon: 25.265 },
      });

      const busLeg = result.itineraries[0].legs[1];
      expect(busLeg.mode).toBe("BUS");
      expect(busLeg.departureTime).toBe("2025-03-08T22:05:00.000Z");
      expect(busLeg.arrivalTime).toBe("2025-03-08T22:25:00.000Z");
      expect(busLeg.routeShortName).toBe("42");
      expect(busLeg.routeColor).toBe("ff0000");
      expect(busLeg.headsign).toBe("City Center");
      expect(busLeg.tripId).toBe("trip:1");
      expect(busLeg.intermediateStops).toBe(1);
      expect(busLeg.polyline).toBe("poly_bus");
    });

    it("planTrip computes walkingDistanceMeters from WALK legs", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.68, lon: 25.28 },
        to:   { lat: 54.645, lon: 25.265 },
      });

      // 400 (first walk) + 350 (last walk) = 750
      expect(result.itineraries[0].walkingDistanceMeters).toBe(750);
    });

    // --- searchStops ---

    it("searchStops maps geocode response to Stop[]", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await adapter.searchStops("station");

      expect(stops).toHaveLength(3);
      expect(stops[0]).toEqual({
        id: "stop:A",
        name: "Central Station",
        location: { lat: 54.68, lon: 25.28 },
      });
      expect(stops[1]).toEqual({
        id: "stop:B",
        name: "Airport",
        location: { lat: 54.64, lon: 25.28 },
      });
    });

    it("searchStops respects limit parameter", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await adapter.searchStops("station", 2);
      expect(stops).toHaveLength(2);
    });

    // --- getNearbyStops ---

    it("getNearbyStops maps index/stops response to Stop[]", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(INDEX_STOPS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await adapter.getNearbyStops({ lat: 54.68, lon: 25.28 });

      expect(stops).toHaveLength(2);
      expect(stops[0]).toEqual({
        id: "stop:near1",
        name: "Market Square",
        location: { lat: 54.681, lon: 25.281 },
      });
    });

    // --- getDepartures ---

    it("getDepartures maps stoptimes with correct fields", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(STOPTIMES_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const departures = await adapter.getDepartures("stop:1");
      expect(departures).toHaveLength(2);

      const first = departures[0];
      // serviceDay 1741392000s * 1000 + scheduledDeparture 3600s * 1000
      expect(first.scheduledTime).toBe(
        new Date(1741392000 * 1000 + 3600 * 1000).toISOString()
      );
      expect(first.predictedTime).toBe(
        new Date(1741392000 * 1000 + 3720 * 1000).toISOString()
      );
      expect(first.delaySeconds).toBe(120);
      expect(first.routeShortName).toBe("42");
      expect(first.routeColor).toBe("00aaff");
      expect(first.mode).toBe("BUS");
      expect(first.headsign).toBe("Airport");
      expect(first.tripId).toBe("trip:bus42");

      const second = departures[1];
      expect(second.predictedTime).toBeUndefined();
      expect(second.delaySeconds).toBeUndefined();
      expect(second.mode).toBe("TRAM");
      expect(second.routeShortName).toBe("5");
    });

    // --- healthCheck ---

    it("healthCheck returns true when API is reachable", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ routerId: "default" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      expect(await adapter.healthCheck()).toBe(true);
    });

    it("healthCheck returns false on network error", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      expect(await adapter.healthCheck()).toBe(false);
    });

    it("healthCheck returns false on non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Not Found", { status: 404, statusText: "Not Found" })
      );

      expect(await adapter.healthCheck()).toBe(false);
    });

    // --- error handling ---

    it("throws on non-ok API response for planTrip", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        })
      );

      await expect(
        adapter.planTrip({
          from: { lat: 54.68, lon: 25.28 },
          to:   { lat: 54.64, lon: 25.27 },
        })
      ).rejects.toThrow("OTP API error: 500 Internal Server Error");
    });
  });
});
