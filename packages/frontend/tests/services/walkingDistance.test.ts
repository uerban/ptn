import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/isochrone.ts", () => ({
  findReachableStops: vi.fn(),
}));
vi.mock("../../src/services/wasmPlanner.ts", () => ({
  planOnDevice: vi.fn(async () => []),
  resolveDepartureOnDevice: vi.fn(async (unix: number) => {
    const d = new Date(unix * 1000);
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return { serviceDate: ymd, timeOriginUnix: 0, departureSecs: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
  }),
}));

import type { RaptorItinerary } from "@pt/shared";
import { composeItineraries, rankResults } from "../../src/services/raptorComposer.ts";
import { SearchOrchestrator, type SearchConfig } from "../../src/services/searchOrchestrator.ts";
import { findReachableStops } from "../../src/services/isochrone.ts";
import { planOnDevice, resolveDepartureOnDevice } from "../../src/services/wasmPlanner.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

const ride: RaptorItinerary = {
  legs: [
    {
      type: "transit",
      fromStopId: "S1",
      toStopId: "S2",
      departSecs: 29100,
      arriveSecs: 30000,
      routeId: "R1",
      tripId: "T1",
      boardStopIdx: 0,
      alightStopIdx: 1,
    },
  ],
  boardSecs: 29100,
  alightSecs: 30000,
  transfers: 0,
};

describe("composeItineraries — walked metres", () => {
  it("sums the entry and exit distances, whatever speed made the seconds", () => {
    // 400 m + 200 m at 3.5 km/h (0.9722 m/s): 411 s + 206 s.
    const [c] = composeItineraries(
      [ride],
      [{ stopId: "S1", walkSecs: 411, distanceMeters: 400 }],
      [{ stopId: "S2", walkSecs: 206, distanceMeters: 200 }],
      28500,
    );
    expect(c.totalWalkSecs).toBe(617);
    expect(c.totalWalkMeters).toBe(600);
  });

  it("counts a run to catch by its distance, not its shorter time", () => {
    const [c] = composeItineraries(
      [ride],
      [{ stopId: "S1", walkSecs: 160, distanceMeters: 400, runToCatch: true }],
      [{ stopId: "S2", walkSecs: 0, distanceMeters: 0 }],
      28500,
    );
    expect(c.totalWalkMeters).toBe(400);
  });

  it("leaves the metres out when an endpoint has no distance", () => {
    const [c] = composeItineraries(
      [ride],
      [{ stopId: "S1", walkSecs: 300 }],
      [{ stopId: "S2", walkSecs: 0, distanceMeters: 0 }],
      28500,
    );
    expect(c.totalWalkMeters).toBeUndefined();
  });
});

const index: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map([
    ["svc1", { serviceId: "svc1", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20271231", exceptions: {} }],
  ]),
};

describe("SearchOrchestrator — walked metres reach the result", () => {
  beforeEach(() => {
    vi.mocked(findReachableStops)
      .mockReset()
      .mockResolvedValueOnce([{ stopId: "S1", walkSecs: 411, distanceMeters: 400 }])
      .mockResolvedValueOnce([{ stopId: "S2", walkSecs: 206, distanceMeters: 200 }]);
    vi.mocked(planOnDevice).mockReset().mockResolvedValue([ride]);
  });

  it("carries the reach search's distances into the composed itinerary", async () => {
    const config: SearchConfig = {
      raptorIndex: index,
      allStops: [
        { id: "S1", name: "S1", lat: 54.68, lon: 25.28 },
        { id: "S2", name: "S2", lat: 54.7, lon: 25.28 },
      ],
      getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      walkSpeedMps: 3.5 / 3.6,
      mobilityProfile: "vision_impaired",
    };
    const [result] = await new SearchOrchestrator(config).search({
      origin: { lat: 54.676, lon: 25.28 },
      destination: { lat: 54.702, lon: 25.28 },
      departureTime: new Date(2026, 2, 30, 7, 55, 0),
      ranking: "fastest",
    });
    expect(result.totalWalkSecs).toBe(617);
    expect(result.totalWalkMeters).toBe(600);
  });
});


describe("routed direct walking with no reachable transit stops", () => {
  it.each(["fastest", "least_walking", "fewest_transfers"] as const)("returns walking in %s mode", async ranking => {
    vi.mocked(findReachableStops).mockReset().mockResolvedValue([]);
    vi.mocked(planOnDevice).mockReset();
    vi.mocked(resolveDepartureOnDevice).mockClear();
    const route = { distanceMeters: 15, coords: [[25.28,54.68],[25.2801,54.68]] as [number,number][], steps: [] };
    const config: SearchConfig = {
      raptorIndex: index, allStops: [], getDelay: () => null,
      osrm: { isReady: () => false, table: vi.fn(), init: vi.fn() } as never,
      walkSpeedMps: 1.5, directWalkRoute: async () => route,
    };
    const results = await new SearchOrchestrator(config).search({
      origin: {lat:54.68,lon:25.28}, destination:{lat:54.68,lon:25.2801},
      departureTime: new Date(2026,2,30,8), ranking,
    });
    expect(results).toHaveLength(1);
    expect(results[0].directWalk?.route).toBe(route);
    expect(results[0].totalWalkMeters).toBe(15);
    expect(planOnDevice).not.toHaveBeenCalled();
    expect(resolveDepartureOnDevice).not.toHaveBeenCalled();
  });
});


it("includes transfer walking without claiming unknown physical metres", () => {
 const transfer = {type:"walk" as const,fromStopId:"S2",toStopId:"S3",departSecs:30000,arriveSecs:30120};
 const itinerary = {...ride,legs:[...ride.legs,transfer],alightSecs:30120};
 const compose = (distanceMeters?:number) => composeItineraries([{...itinerary,legs:[...ride.legs,{...transfer,distanceMeters}]}],
  [{stopId:"S1",walkSecs:10,distanceMeters:15}], [{stopId:"S3",walkSecs:20,distanceMeters:30}],28500)[0];
 expect(compose().totalWalkSecs).toBe(150);
 expect(compose().totalWalkMeters).toBeUndefined();
 expect(compose(80).totalWalkMeters).toBe(125);
});

it("ranks known physical distance independently of run duration", () => {
 const base=composeItineraries([ride],[{stopId:"S1",walkSecs:5,distanceMeters:100}],
  [{stopId:"S2",walkSecs:0,distanceMeters:0}],28500)[0];
 const direct={...base,legs:[],totalWalkMeters:15,totalWalkSecs:10,totalSecs:10};
 expect(rankResults([base,direct],"least_walking")[0]).toBe(direct);
});


it.each(["fastest", "least_walking", "fewest_transfers"] as const)("merges walking before the final limit in %s", async ranking => {
 vi.mocked(findReachableStops).mockReset()
  .mockResolvedValueOnce([{stopId:"S1",walkSecs:30,distanceMeters:45}])
  .mockResolvedValueOnce([{stopId:"S2",walkSecs:30,distanceMeters:45}]);
 vi.mocked(planOnDevice).mockReset().mockResolvedValue([ride]);
 const orchestrator=new SearchOrchestrator({raptorIndex:index,allStops:[],getDelay:()=>null,maxResults:1,
  osrm:{isReady:()=>false,table:vi.fn(),init:vi.fn()} as never,
  directWalkRoute:async()=>({distanceMeters:15,coords:[[25.28,54.68],[25.2801,54.68]],steps:[]})});
 const result=await orchestrator.search({origin:{lat:54.68,lon:25.28},destination:{lat:54.68,lon:25.2801},departureTime:new Date(2026,2,30,7,55),ranking});
 expect(result).toHaveLength(1);
 expect(result[0].directWalk).toBeDefined();
});

it("keeps a legitimate faster transit winner", async () => {
 vi.mocked(findReachableStops).mockReset()
  .mockResolvedValueOnce([{stopId:"S1",walkSecs:0,distanceMeters:0}])
  .mockResolvedValueOnce([{stopId:"S2",walkSecs:0,distanceMeters:0}]);
 vi.mocked(planOnDevice).mockReset().mockResolvedValue([ride]);
 const orchestrator=new SearchOrchestrator({raptorIndex:index,allStops:[],getDelay:()=>null,maxResults:1,
  osrm:{isReady:()=>false,table:vi.fn(),init:vi.fn()} as never,
  directWalkRoute:async()=>({distanceMeters:15000,coords:[[25.28,54.68],[25.4,54.68]],steps:[]})});
 const result=await orchestrator.search({origin:{lat:54.68,lon:25.28},destination:{lat:54.68,lon:25.4},departureTime:new Date(2026,2,30,7,55),ranking:"fastest"});
 expect(result[0].directWalk).toBeUndefined();
 expect(result[0].legs[0].type).toBe("transit");
});

it.each([[30,true],[181,false]] as const)("revalidates %sm routed transfer before merging walking",async(distance,retained)=>{
 vi.mocked(findReachableStops).mockReset()
  .mockResolvedValueOnce([{stopId:"S1",walkSecs:0,distanceMeters:0}])
  .mockResolvedValueOnce([{stopId:"S4",walkSecs:0,distanceMeters:0}]);
 vi.mocked(planOnDevice).mockReset().mockResolvedValue([{
  ...ride,alightSecs:31000,transfers:1,legs:[ride.legs[0],
   {type:"walk",fromStopId:"S2",toStopId:"S3",departSecs:30000,arriveSecs:30120},
   {...ride.legs[0],fromStopId:"S3",toStopId:"S4",departSecs:30240,arriveSecs:31000,tripId:"T2"}],
 }]);
 const config:SearchConfig={raptorIndex:index,walkSpeedMps:1.5,getDelay:()=>null,
  allStops:[{id:"S2",name:"S2",lat:54.69,lon:25.28},{id:"S3",name:"S3",lat:54.70,lon:25.28}],
  osrm:{isReady:()=>false,table:vi.fn(),init:vi.fn()} as never,
  directWalkRoute:async(from)=>({distanceMeters:from.lat===54.69?distance:1000,
   coords:[[25.28,54.69],[25.28,54.70]],steps:[]})};
 const results=await new SearchOrchestrator(config).search({origin:{lat:54.68,lon:25.28},destination:{lat:54.71,lon:25.28},departureTime:new Date(2026,2,30,7,55),ranking:"least_walking"});
 expect(results.some(result=>!!result.directWalk)).toBe(true);
 expect(results.some(result=>result.legs.length>0)).toBe(retained);
 if(retained) expect(results.find(result=>result.legs.length>0)?.totalWalkMeters).toBe(30);
});
