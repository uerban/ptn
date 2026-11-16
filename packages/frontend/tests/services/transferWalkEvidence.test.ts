import {WalkGraphUnavailableError} from "../../src/services/walkGraphClient.ts";
import {it,expect,vi} from "vitest";
import type {RaptorItinerary} from "@pt/shared";
import {transferWalkEvidence} from "../../src/services/transferWalkEvidence.ts";
const itinerary:RaptorItinerary={legs:[{type:"walk",fromStopId:"A",toStopId:"B",departSecs:0,arriveSecs:120}],boardSecs:0,alightSecs:120,transfers:0};
const stops=[{id:"A",lat:54,lon:25},{id:"B",lat:54,lon:25.001}];
it("preserves physical distance and transfer buffer, deduplicating route work",async()=>{
 const route=vi.fn(async()=>({distanceMeters:30,coords:[[25,54],[25.001,54]] as [number,number][],steps:[]}));
 const result=await transferWalkEvidence([itinerary,itinerary],stops,route,1.5);
 expect(result).toHaveLength(2);
 expect(result[0].legs[0]).toMatchObject({distanceMeters:30,departSecs:100,arriveSecs:120});
 expect(route).toHaveBeenCalledTimes(1);
 expect(itinerary.legs[0]).not.toHaveProperty("distanceMeters");
});
it("rejects longer or unreachable pedestrian transfers",async()=>{
 expect(await transferWalkEvidence([itinerary],stops,async()=>({distanceMeters:181,coords:[[25,54],[25.001,54]],steps:[]}),1.5)).toEqual([]);
 expect(await transferWalkEvidence([itinerary],stops,async()=>null,1.5)).toEqual([]);
});


it("rejects malformed geometry independently of distance and validates pace",async()=>{
 expect(await transferWalkEvidence([itinerary],stops,async()=>({distanceMeters:1,coords:[[NaN,54],[25,54]],steps:[]}),1.5)).toEqual([]);
 await expect(transferWalkEvidence([itinerary],stops,async()=>null,0)).rejects.toThrow(/speed/);
});


it("preserves unknown transfer metres on transient provider failure",async()=>{
 const result=await transferWalkEvidence([itinerary],stops,async()=>{throw new WalkGraphUnavailableError("fixture","transient");},1.5);
 expect(result).toHaveLength(1);
 expect(result[0].legs[0]).not.toHaveProperty("distanceMeters");
 await expect(transferWalkEvidence([itinerary],stops,async()=>{throw new Error("bug");},1.5)).rejects.toThrow("bug");
});


it("preserves transfer deadline while separating walking from the buffer",async()=>{
 const result=await transferWalkEvidence([itinerary],stops,async()=>({distanceMeters:30,coords:[[25,54],[25.001,54]],steps:[]}),0.75);
 expect(result[0].legs[0]).toMatchObject({departSecs:80,arriveSecs:120,distanceMeters:30});
 expect(result[0].alightSecs).toBe(itinerary.alightSecs);
});
