import {it,expect} from "vitest";
import type {RtComposedItinerary} from "../../src/services/rtOverlay.ts";
import {feasibleRtCandidates} from "../../src/services/rtFeasibility.ts";
const ride={type:"transit" as const,fromStopId:"A",toStopId:"B",departSecs:0,arriveSecs:100,routeId:"R",tripId:"T",boardStopIdx:0,alightStopIdx:1};
const fixture:RtComposedItinerary={legs:[ride,{type:"walk",fromStopId:"B",toStopId:"C",departSecs:110,arriveSecs:130},{...ride,fromStopId:"C",toStopId:"D",departSecs:240,arriveSecs:300}],sourceWalkSecs:0,destWalkSecs:10,totalWalkSecs:20,departureSecs:0,arrivalSecs:310,totalSecs:310,transfers:1};
it("shifts walking within slack and preserves physical duration",()=>{
 const input={...fixture,legs:[{...ride,arriveSecs:120},...fixture.legs.slice(1)]};
 const [result]=feasibleRtCandidates([input]);
 expect(result.legs[1]).toMatchObject({departSecs:120,arriveSecs:140});
 expect(input.legs[1].departSecs).toBe(110);
 expect(result.arrivalSecs).toBe(310);
});
it("rejects physical overlap across walks",()=>{
 expect(feasibleRtCandidates([{...fixture,legs:[{...ride,arriveSecs:230},...fixture.legs.slice(1)]}])).toEqual([]);
 expect(feasibleRtCandidates([fixture])).toHaveLength(1);
});
it("excludes cancelled and timing-unreliable candidates",()=>{
 expect(feasibleRtCandidates([{...fixture,cancelled:true},{...fixture,timingUnreliable:true}])).toEqual([]);
});
