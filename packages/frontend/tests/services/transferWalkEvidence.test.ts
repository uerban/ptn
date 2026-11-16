import {it,expect,vi} from "vitest";
import type {RaptorItinerary} from "@pt/shared";
import {transferWalkEvidence} from "../../src/services/transferWalkEvidence.ts";
const itinerary:RaptorItinerary={legs:[{type:"walk",fromStopId:"A",toStopId:"B",departSecs:0,arriveSecs:120}],boardSecs:0,alightSecs:120,transfers:0};
const stops=[{id:"A",lat:54,lon:25},{id:"B",lat:54,lon:25.001}];
it("preserves physical distance and transfer buffer, deduplicating route work",async()=>{
 const route=vi.fn(async()=>({distanceMeters:30,coords:[[25,54],[25.001,54]] as [number,number][],steps:[]}));
 const result=await transferWalkEvidence([itinerary,itinerary],stops,route,1.5);
 expect(result).toHaveLength(2);
 expect(result[0].legs[0]).toMatchObject({distanceMeters:30,arriveSecs:120});
 expect(route).toHaveBeenCalledTimes(1);
 expect(itinerary.legs[0]).not.toHaveProperty("distanceMeters");
});
it("rejects longer or unreachable pedestrian transfers",async()=>{
 expect(await transferWalkEvidence([itinerary],stops,async()=>({distanceMeters:181,coords:[],steps:[]}),1.5)).toEqual([]);
 expect(await transferWalkEvidence([itinerary],stops,async()=>null,1.5)).toEqual([]);
});
