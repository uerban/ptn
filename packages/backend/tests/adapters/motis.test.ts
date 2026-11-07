import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MotisAdapter } from "../../src/adapters/motis.js";

// Realistic Transitous API fixtures based on actual responses
const GEOCODE_STOTIS_RESPONSE = [
  {
    type: "STOP",
    tokens: [[0, 6]],
    name: "Stotis",
    id: "lt-vilnius_16581",
    lat: 54.67191,
    lon: 25.28338,
    level: 0,
    country: "LT",
    tz: "Europe/Vilnius",
    areas: [
      { name: "Vilnius", adminLevel: 8, matched: false, unique: true, default: true },
    ],
    score: -5.374,
    modes: ["BUS"],
    importance: 0.0125,
  },
  {
    type: "STOP",
    tokens: [[0, 6]],
    name: "Stotis",
    id: "lt-visimarsrutai_23945",
    lat: 55.91857,
    lon: 21.85184,
    level: 0,
    country: "LT",
    tz: "Europe/Vilnius",
    score: -5.254,
    modes: ["BUS"],
    importance: 0.000558,
  },
  {
    type: "PLACE",
    category: "supermarket_14",
    tokens: [[0, 6]],
    name: "IKI Stotis",
    id: "node/322937618",
    lat: 54.6704405,
    lon: 25.2820095,
    country: "LT",
  },
];

const GEOCODE_ORO_UOSTAS_RESPONSE = [
  {
    type: "PLACE",
    category: "none",
    tokens: [[0, 3], [4, 6]],
    name: "Oro uostas",
    id: "way/325963870",
    lat: 54.6425492,
    lon: 25.2765358,
    country: "LT",
  },
  {
    type: "STOP",
    tokens: [[0, 3], [4, 6]],
    name: "Oro uostas",
    id: "lt-LTG-Link_Oro uostas",
    lat: 54.642628,
    lon: 25.276487,
    level: 0,
    country: "LT",
    tz: "Europe/Vilnius",
    score: -6.614,
    modes: ["REGIONAL_FAST_RAIL", "BUS"],
    importance: 0.0015,
  },
  {
    type: "STOP",
    tokens: [[0, 3], [4, 6]],
    name: "Oro uostas",
    id: "lt-B-Bus_4648",
    lat: 55.97187,
    lon: 21.09866,
    level: 0,
    country: "LT",
    score: -6.602,
    modes: ["BUS"],
    importance: 0.000323,
  },
];

const PLAN_VILNIUS_RESPONSE = {
  itineraries: [
    {
      duration: 1740,
      startTime: "2026-03-08T22:12:00Z",
      endTime: "2026-03-08T22:41:00Z",
      transfers: 0,
      legs: [
        {
          mode: "WALK",
          from: {
            name: "START",
            lat: 54.6708,
            lon: 25.2813,
            level: 0,
            departure: "2026-03-08T22:12:00Z",
            scheduledDeparture: "2026-03-08T22:12:00Z",
            vertexType: "NORMAL",
          },
          to: {
            name: "Pelesos st.",
            stopId: "lt-vilnius_5941",
            lat: 54.6711,
            lon: 25.2912,
            arrival: "2026-03-08T22:24:00Z",
            scheduledArrival: "2026-03-08T22:24:00Z",
            vertexType: "TRANSIT",
            modes: ["BUS"],
          },
          duration: 720,
          distance: 809,
          realTime: false,
          legGeometry: { points: "abc123", precision: 7, length: 100 },
        },
        {
          mode: "BUS",
          from: {
            name: "Pelesos st.",
            stopId: "lt-vilnius_5941",
            lat: 54.6671,
            lon: 25.2912,
            departure: "2026-03-08T22:24:00Z",
            scheduledDeparture: "2026-03-08T22:24:00Z",
            vertexType: "TRANSIT",
            modes: ["BUS"],
          },
          to: {
            name: "Oro uostas",
            stopId: "lt-vilnius_18375",
            lat: 54.6444,
            lon: 25.278,
            arrival: "2026-03-08T22:36:00Z",
            scheduledArrival: "2026-03-08T22:36:00Z",
            vertexType: "TRANSIT",
            modes: ["REGIONAL_FAST_RAIL", "BUS"],
          },
          duration: 720,
          startTime: "2026-03-08T22:24:00Z",
          endTime: "2026-03-08T22:36:00Z",
          realTime: true,
          headsign: "Oro uostas",
          routeId: "vilnius_bus_88",
          routeColor: "0073ac",
          routeShortName: "88",
          tripId: "20260308_24:10_lt-vilnius_A88-01-6-260302-ba-2410",
          intermediateStops: [
            { name: "Stop A", stopId: "lt-vilnius_1001", lat: 54.66, lon: 25.285 },
            { name: "Stop B", stopId: "lt-vilnius_1002", lat: 54.655, lon: 25.282 },
            { name: "Stop C", stopId: "lt-vilnius_1003", lat: 54.65, lon: 25.28 },
            { name: "Stop D", stopId: "lt-vilnius_1004", lat: 54.648, lon: 25.279 },
          ],
          legGeometry: { points: "def456", precision: 7, length: 85 },
        },
        {
          mode: "WALK",
          from: {
            name: "Oro uostas",
            stopId: "lt-vilnius_18375",
            lat: 54.6444,
            lon: 25.278,
            departure: "2026-03-08T22:36:00Z",
            scheduledDeparture: "2026-03-08T22:36:00Z",
            vertexType: "TRANSIT",
          },
          to: {
            name: "END",
            lat: 54.6426,
            lon: 25.2765,
            arrival: "2026-03-08T22:41:00Z",
            scheduledArrival: "2026-03-08T22:41:00Z",
            vertexType: "NORMAL",
          },
          duration: 300,
          distance: 354,
          realTime: false,
          legGeometry: { points: "ghi789", precision: 7, length: 29 },
        },
      ],
    },
  ],
  nextPageCursor: "cursor_abc123",
};

const STOPTIMES_RESPONSE = {
  stopTimes: [
    {
      place: {
        name: "Pelesos st.",
        stopId: "lt-vilnius_5941",
        lat: 54.6671,
        lon: 25.2913,
        arrival: "2026-03-08T23:38:00Z",
        departure: "2026-03-08T23:40:00Z",
        scheduledArrival: "2026-03-08T23:38:00Z",
        scheduledDeparture: "2026-03-08T23:38:00Z",
        cancelled: false,
      },
      mode: "BUS",
      realTime: true,
      headsign: "Oro uostas",
      routeId: "vilnius_bus_88",
      routeShortName: "88",
      routeColor: "0073ac",
      tripId: "20260308_25:24_lt-vilnius_A88-01-6-260302-ba-2520",
      cancelled: false,
    },
    {
      place: {
        name: "Pelesos st.",
        stopId: "lt-vilnius_5941",
        lat: 54.6671,
        lon: 25.2913,
        arrival: "2026-03-08T23:55:00Z",
        departure: "2026-03-08T23:55:00Z",
        scheduledArrival: "2026-03-08T23:55:00Z",
        scheduledDeparture: "2026-03-08T23:55:00Z",
        cancelled: false,
      },
      mode: "BUS",
      realTime: false,
      headsign: "Centras",
      routeId: "vilnius_bus_3G",
      routeShortName: "3G",
      tripId: "20260308_25:55_lt-vilnius_A3G-01-1-260302-ba-2555",
      cancelled: false,
    },
  ],
};

describe("MotisAdapter", () => {
  const adapter = new MotisAdapter();

  it("has correct name", () => {
    expect(adapter.name).toBe("motis");
  });

  it("implements RoutingAdapter interface", () => {
    expect(typeof adapter.planTrip).toBe("function");
    expect(typeof adapter.getNearbyStops).toBe("function");
    expect(typeof adapter.getDepartures).toBe("function");
    expect(typeof adapter.searchStops).toBe("function");
    expect(typeof adapter.getVehiclePositions).toBe("function");
    expect(typeof adapter.healthCheck).toBe("function");
  });

  it("getVehiclePositions returns empty array (phase 2 feature)", async () => {
    const positions = await adapter.getVehiclePositions!({
      minLat: 52.4,
      minLon: 13.2,
      maxLat: 52.6,
      maxLon: 13.5,
    });
    expect(positions).toEqual([]);
  });

  describe("response mapping with Transitous API fixtures", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("searchStops('stotis') returns only STOP results with correct mapping", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_STOTIS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await adapter.searchStops("stotis");

      // Should filter out PLACE type results (IKI Stotis)
      expect(stops).toHaveLength(2);
      expect(stops[0]).toEqual({
        id: "lt-vilnius_16581",
        name: "Stotis",
        location: { lat: 54.67191, lon: 25.28338 },
      });
      expect(stops[1]).toEqual({
        id: "lt-visimarsrutai_23945",
        name: "Stotis",
        location: { lat: 55.91857, lon: 21.85184 },
      });
    });

    it("searchStops('oro uostas') returns only STOP results, filtering out PLACE", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_ORO_UOSTAS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await adapter.searchStops("oro uostas");

      // Should filter out the PLACE result (first item is type: PLACE)
      expect(stops).toHaveLength(2);
      expect(stops[0]).toEqual({
        id: "lt-LTG-Link_Oro uostas",
        name: "Oro uostas",
        location: { lat: 54.642628, lon: 25.276487 },
      });
      expect(stops[1]).toEqual({
        id: "lt-B-Bus_4648",
        name: "Oro uostas",
        location: { lat: 55.97187, lon: 21.09866 },
      });
    });

    it("searchStops respects the limit parameter", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_STOTIS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await adapter.searchStops("stotis", 1);
      expect(stops).toHaveLength(1);
    });

    // A generic Lithuanian stop name where upstream ranks every out-of-city
    // match ABOVE the Vilnius one — the shape that makes local matches fall off
    // the end of the list. The fixtures above cannot show this: they already
    // happen to put Vilnius first, so they pass with or without the ordering.
    const GEOCODE_GENERIC_NAME_RESPONSE = [
      { type: "STOP", name: "Geležinkelio stotis", id: "lt-kaunas_1", lat: 54.8879, lon: 23.9331 },
      { type: "PLACE", name: "Geležinkelio stotis", id: "place-1", lat: 54.3986, lon: 23.9832 },
      { type: "STOP", name: "Geležinkelio stotis", id: "lt-panevezys_1", lat: 55.7449, lon: 24.3537 },
      { type: "STOP", name: "Geležinkelio stotis", id: "lt-vilnius_9", lat: 54.6720, lon: 25.2820 },
    ];
    const VILNIUS_BBOX = { minLat: 54.62, minLon: 25.15, maxLat: 54.75, maxLon: 25.42 };

    it("searchStops leaves upstream order alone when no city bbox is configured", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_GENERIC_NAME_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await new MotisAdapter().searchStops("Geležinkelio stotis");

      expect(stops.map((s) => s.id)).toEqual([
        "lt-kaunas_1",
        "lt-panevezys_1",
        "lt-vilnius_9",
      ]);
    });

    it("searchStops puts in-city stops first without dropping the rest", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_GENERIC_NAME_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const local = new MotisAdapter(undefined, VILNIUS_BBOX);
      const stops = await local.searchStops("Geležinkelio stotis");

      // Vilnius promoted from last to first; the other two survive, in their
      // original relative order. Ordering, not filtering — the remote provider
      // exists to reach stops the local bundle lacks.
      expect(stops.map((s) => s.id)).toEqual([
        "lt-vilnius_9",
        "lt-kaunas_1",
        "lt-panevezys_1",
      ]);
    });

    it("searchStops keeps the in-city stop when limit would have truncated it", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(GEOCODE_GENERIC_NAME_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const local = new MotisAdapter(undefined, VILNIUS_BBOX);
      const stops = await local.searchStops("Geležinkelio stotis", 1);

      // This is the actual bug: at limit=1 the old code returned Kaunas and the
      // Vilnius stop was never transmitted, so nothing downstream could rank it
      // back into view.
      expect(stops.map((s) => s.id)).toEqual(["lt-vilnius_9"]);
    });

    it("searchStops cannot invent a local match upstream never returned", async () => {
      const noVilnius = GEOCODE_GENERIC_NAME_RESPONSE.filter(
        (r) => r.id !== "lt-vilnius_9"
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(noVilnius), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const local = new MotisAdapter(undefined, VILNIUS_BBOX);
      const stops = await local.searchStops("Geležinkelio stotis");

      // Ordering is not a search. When the geocoder sends nothing inside the
      // bbox there is nothing to promote, which is why the Vilnius harness test
      // needs a query that upstream actually answers locally.
      expect(stops.map((s) => s.id)).toEqual(["lt-kaunas_1", "lt-panevezys_1"]);
    });

    it("planTrip maps Vilnius bus station to airport itinerary correctly", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_VILNIUS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.6708, lon: 25.2813 },
        to: { lat: 54.6426, lon: 25.2765 },
      });

      expect(result.itineraries).toHaveLength(1);
      expect(result.nextPageCursor).toBe("cursor_abc123");

      const itinerary = result.itineraries[0];
      expect(itinerary.departureTime).toBe("2026-03-08T22:12:00Z");
      expect(itinerary.arrivalTime).toBe("2026-03-08T22:41:00Z");
      expect(itinerary.durationSeconds).toBe(1740);
      expect(itinerary.transfers).toBe(0);
      expect(itinerary.legs).toHaveLength(3);
    });

    it("planTrip maps WALK legs with from.departure/to.arrival fallback", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_VILNIUS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.6708, lon: 25.2813 },
        to: { lat: 54.6426, lon: 25.2765 },
      });

      // First leg is WALK - no top-level startTime/endTime, uses from.departure/to.arrival
      const walkLeg = result.itineraries[0].legs[0];
      expect(walkLeg.mode).toBe("WALK");
      expect(walkLeg.departureTime).toBe("2026-03-08T22:12:00Z");
      expect(walkLeg.arrivalTime).toBe("2026-03-08T22:24:00Z");
      expect(walkLeg.durationSeconds).toBe(720);
      expect(walkLeg.distanceMeters).toBe(809);
      expect(walkLeg.from.name).toBe("START");
      expect(walkLeg.to.name).toBe("Pelesos st.");
      expect(walkLeg.to.stopId).toBe("lt-vilnius_5941");
      expect(walkLeg.polyline).toBe("abc123");

      // Last leg is also WALK
      const lastWalkLeg = result.itineraries[0].legs[2];
      expect(lastWalkLeg.mode).toBe("WALK");
      expect(lastWalkLeg.departureTime).toBe("2026-03-08T22:36:00Z");
      expect(lastWalkLeg.arrivalTime).toBe("2026-03-08T22:41:00Z");
    });

    it("planTrip surfaces a walk-only journey under direct, leaving itineraries empty", async () => {
      // What Transitous returns for a walkable pair: nothing in `itineraries`,
      // the walk in `direct`. Krakow Glowny -> Rynek Glowny, 1.1 km.
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            itineraries: [],
            direct: [
              {
                duration: 1105,
                startTime: "2026-03-08T22:12:00Z",
                endTime: "2026-03-08T22:30:25Z",
                legs: [
                  {
                    mode: "WALK",
                    duration: 1105,
                    distance: 1534,
                    from: { name: "START", lat: 50.0677, lon: 19.9467 },
                    to: { name: "END", lat: 50.0616, lon: 19.9373 },
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const result = await adapter.planTrip({
        from: { lat: 50.0677, lon: 19.9467 },
        to: { lat: 50.0616, lon: 19.9373 },
      });

      // An empty `itineraries` still means "no transit route here" — the walk
      // must not be smuggled in, or that answer becomes unrepresentable.
      expect(result.itineraries).toEqual([]);

      expect(result.direct).toHaveLength(1);
      const walk = result.direct![0];
      expect(walk.durationSeconds).toBe(1105);
      expect(walk.transfers).toBe(0);
      expect(walk.walkingDistanceMeters).toBe(1534);
      expect(walk.legs.map((l) => l.mode)).toEqual(["WALK"]);
    });

    it("planTrip omits direct entirely when the response has no transit-free option", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_VILNIUS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.6708, lon: 25.2813 },
        to: { lat: 54.6426, lon: 25.2765 },
      });

      // Absent rather than an empty array, so `direct` stays a positive signal
      // and consumers can treat presence as "a walk was offered".
      expect(result.direct).toBeUndefined();
      expect(result.itineraries).toHaveLength(1);
    });

    it("planTrip maps BUS transit leg with route details and intermediate stops", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_VILNIUS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.6708, lon: 25.2813 },
        to: { lat: 54.6426, lon: 25.2765 },
      });

      const busLeg = result.itineraries[0].legs[1];
      expect(busLeg.mode).toBe("BUS");
      expect(busLeg.departureTime).toBe("2026-03-08T22:24:00Z");
      expect(busLeg.arrivalTime).toBe("2026-03-08T22:36:00Z");
      expect(busLeg.routeShortName).toBe("88");
      expect(busLeg.routeColor).toBe("0073ac");
      expect(busLeg.headsign).toBe("Oro uostas");
      expect(busLeg.tripId).toBe(
        "20260308_24:10_lt-vilnius_A88-01-6-260302-ba-2410"
      );
      expect(busLeg.intermediateStops).toBe(4);
      expect(busLeg.from.name).toBe("Pelesos st.");
      expect(busLeg.from.stopId).toBe("lt-vilnius_5941");
      expect(busLeg.to.name).toBe("Oro uostas");
      expect(busLeg.to.stopId).toBe("lt-vilnius_18375");
      expect(busLeg.polyline).toBe("def456");
    });

    it("planTrip computes walkingDistanceMeters from WALK legs", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(PLAN_VILNIUS_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await adapter.planTrip({
        from: { lat: 54.6708, lon: 25.2813 },
        to: { lat: 54.6426, lon: 25.2765 },
      });

      // 809 (first walk) + 354 (last walk) = 1163
      expect(result.itineraries[0].walkingDistanceMeters).toBe(1163);
    });

    it("getNearbyStops filters to STOP type only", async () => {
      const reverseGeocodeResponse = [
        {
          type: "STOP",
          name: "Stotis",
          id: "lt-vilnius_16581",
          lat: 54.67191,
          lon: 25.28338,
        },
        {
          type: "PLACE",
          name: "Some Place",
          id: "place_1",
          lat: 54.672,
          lon: 25.284,
        },
      ];

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(reverseGeocodeResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const stops = await adapter.getNearbyStops({ lat: 54.6708, lon: 25.2813 });
      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("lt-vilnius_16581");
    });

    it("getDepartures maps stoptimes response with correct time fields", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(STOPTIMES_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const departures = await adapter.getDepartures("lt-vilnius_5941");
      expect(departures).toHaveLength(2);

      // First departure has realTime=true, so predictedTime should be place.departure
      const first = departures[0];
      expect(first.scheduledTime).toBe("2026-03-08T23:38:00Z");
      expect(first.predictedTime).toBe("2026-03-08T23:40:00Z");
      expect(first.delaySeconds).toBe(120); // 2 minutes late
      expect(first.routeShortName).toBe("88");
      expect(first.routeColor).toBe("0073ac");
      expect(first.headsign).toBe("Oro uostas");
      expect(first.mode).toBe("BUS");
      expect(first.tripId).toBe("20260308_25:24_lt-vilnius_A88-01-6-260302-ba-2520");
      expect(first.cancelled).toBe(false);

      // Second departure has realTime=false, so no predictedTime
      const second = departures[1];
      expect(second.scheduledTime).toBe("2026-03-08T23:55:00Z");
      expect(second.predictedTime).toBeUndefined();
      expect(second.delaySeconds).toBeUndefined();
      expect(second.routeShortName).toBe("3G");
      expect(second.headsign).toBe("Centras");
    });

    it("handles API error responses", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Server Error", { status: 500, statusText: "Internal Server Error" })
      );

      await expect(adapter.searchStops("test")).rejects.toThrow(
        "MOTIS API error: 500 Internal Server Error"
      );
    });

    it("healthCheck returns false on network error", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      const healthy = await adapter.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  // Integration tests — require network access to api.transitous.org
  // Run with: INTEGRATION=1 pnpm --filter @pt/backend test
  const integration = process.env.INTEGRATION ? describe : describe.skip;

  integration("integration (requires network)", () => {
    it("searchStops returns results for a known city", async () => {
      const stops = await adapter.searchStops("Berlin Hauptbahnhof", 5);
      expect(stops.length).toBeGreaterThan(0);
      expect(stops[0]).toHaveProperty("id");
      expect(stops[0]).toHaveProperty("name");
      expect(stops[0]).toHaveProperty("location");
      expect(stops[0].location).toHaveProperty("lat");
      expect(stops[0].location).toHaveProperty("lon");
    }, 15000);

    it("planTrip returns itineraries for a valid query", async () => {
      const result = await adapter.planTrip({
        from: { lat: 52.525, lon: 13.369 },
        to: { lat: 52.5219, lon: 13.4132 },
      });

      expect(result).toHaveProperty("itineraries");
      expect(result.itineraries.length).toBeGreaterThan(0);

      const first = result.itineraries[0];
      expect(first).toHaveProperty("legs");
      expect(first).toHaveProperty("departureTime");
      expect(first).toHaveProperty("arrivalTime");
      expect(first).toHaveProperty("durationSeconds");
      expect(first).toHaveProperty("transfers");
      expect(first.legs.length).toBeGreaterThan(0);
    }, 15000);

    it("healthCheck returns true", async () => {
      const healthy = await adapter.healthCheck();
      expect(healthy).toBe(true);
    }, 10000);
  });
});
