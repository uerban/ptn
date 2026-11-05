import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

// Line 3 from S1 at 08:00, 08:10 and 08:25 (UTC service day, every day).
export const lineThreeIndex = {
  routes: [
    {
      id: "R3",
      shortName: "3",
      mode: "BUS",
      stopIds: ["S1", "S2"],
      trips: [
        { tripId: "T800", serviceId: "ALL", headsign: "Centre", departureSecs: [28800, 29400] },
        { tripId: "T810", serviceId: "ALL", headsign: "Centre", departureSecs: [29400, 30000] },
        { tripId: "T825", serviceId: "ALL", headsign: "Centre", departureSecs: [30300, 30900] },
      ],
    },
  ],
  routeIdToIdx: new Map([["R3", 0]]),
  routesAtStop: new Map([["S1", [0]], ["S2", [0]]]),
  services: new Map([
    ["ALL", { serviceId: "ALL", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20271231", exceptions: {} }],
  ]),
} as unknown as RaptorIndex;
