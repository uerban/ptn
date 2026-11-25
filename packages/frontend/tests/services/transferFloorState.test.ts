import {describe,it,expect} from "vitest";
import {captureTransferFloorState,restoreTransferFloorState} from "../../src/services/transferFloorState.ts";
import {effectiveTransferFloor} from "../../src/services/effectiveTransferRule.ts";
import {transferRuleKey,transferTripScopedKey,transferRouteScopedKey} from "../../src/services/transferRuleKeys.ts";
import {finalizeSearch,replayFinalization,type FinalizationCapture} from "../../src/services/searchFinalization.ts";
import {composeSearchResults,type CompositionCapture} from "../../src/services/searchComposition.ts";
const from={type:"transit" as const,tripId:"T1",routeId:"R1",fromStopId:"A",toStopId:"B",departSecs:100,arriveSecs:300,boardStopIdx:0,alightStopIdx:1};
const to={type:"transit" as const,tripId:"T2",routeId:"R2",fromStopId:"B",toStopId:"C",departSecs:350,arriveSecs:800,boardStopIdx:0,alightStopIdx:1};
const state=()=>({transferRules:new Map([[transferRuleKey("B","B"),{type:3}]]),transferRulesRouteScoped:new Map([[transferRouteScopedKey("B","B","R1","R2"),{type:2,minSecs:30}]]),transferRulesTripScoped:new Map([[transferTripScopedKey("B","B","T1","T2"),{type:1}]])});
const input={composed:[{legs:[from,to],sourceWalkSecs:0,destWalkSecs:0,departureSecs:0,arrivalSecs:800,totalSecs:800,totalWalkSecs:0,totalWalkMeters:0,transfers:1}],walking:null,ranking:"fastest" as const,maxResults:5,minTransferSecs:120};
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
describe("captured transfer-floor rules",()=>{
 it("retains exact tables independently, including absent versus empty maps",()=>{
  const index=state(),snapshot=captureTransferFloorState(index),restored=restoreTransferFloorState(snapshot);
  expect(Object.isFrozen(snapshot.trip)).toBe(true);expect(effectiveTransferFloor(restored,from,to,120)).toBe(0);
  index.transferRulesTripScoped.clear();expect(effectiveTransferFloor(restored,from,to,120)).toBe(0);
  const absent=captureTransferFloorState({transferRules:new Map()});expect(absent.stop).toEqual([]);expect(absent.trip).toBeNull();
 });
 it("recomputes trip-over-route-over-stop precedence and rejects altered answers/state",()=>{
  const index=state();let record!:FinalizationCapture;
  const output=finalizeSearch(input,()=>null,(a,b)=>effectiveTransferFloor(index,a,b,120),r=>{record=r;},()=>captureTransferFloorState(index));
  expect(output).toHaveLength(1);expect(replayFinalization(record)).toEqual(output);
  const changed=clone(record);changed.floorRules!.trip![0][1].type=3;expect(()=>replayFinalization(changed)).toThrow("differs from captured rule state");
  const answer=clone(record);const read=answer.reads.find(r=>r.kind==="floor")!;read.value=999;expect(()=>replayFinalization(answer)).toThrow();
 });
 it("keeps forbidden transfer separate from a successful feasible candidate",()=>{
  const index=state();index.transferRulesTripScoped.set(transferTripScopedKey("B","B","T1","T2"),{type:3});let record!:FinalizationCapture;
  expect(finalizeSearch(input,()=>null,(a,b)=>effectiveTransferFloor(index,a,b,120),r=>{record=r;},()=>captureTransferFloorState(index))).toEqual([]);
  expect(replayFinalization(record)).toEqual([]);expect(record.reads.some(read=>read.kind==="floor"&&read.value===null)).toBe(true);
 });
 it("does not allow boarding before physical arrival under a zero floor",()=>{
  const index=state();let record!:FinalizationCapture;
  const earlier={...input,composed:[{...input.composed[0],legs:[from,{...to,departSecs:299}]}]};
  expect(finalizeSearch(earlier,()=>null,(a,b)=>effectiveTransferFloor(index,a,b,120),r=>{record=r;},()=>captureTransferFloorState(index))).toEqual([]);
  expect(replayFinalization(record)).toEqual([]);
 });
 it("keeps a short certified continuation and rejects an ordinary connection with the same times",()=>{
  const floor=()=>120;
  expect(finalizeSearch(input,()=>null,floor)).toEqual([]);
  const continuation={...input,composed:[{...input.composed[0],transfers:0,legs:[from,{...to,inSeat:true}]}]};
  let record!:FinalizationCapture;
  const output=finalizeSearch(continuation,()=>null,floor,r=>{record=r;});
  expect(output).toHaveLength(1);expect(replayFinalization(record)).toEqual(output);
  const delay=(tripId:string)=>tripId==="T1"?{delaySeconds:60,cancelled:false}:null;
  expect(finalizeSearch(continuation,delay,floor)).toEqual([]);
 });
 it("snapshots after asynchronous walking evidence, at the synchronous floor boundary",async()=>{
  const index={transferRules:new Map([[transferRuleKey("B","X"),{type:1}]])};let record!:CompositionCapture;
  const planned={boardSecs:100,alightSecs:800,transfers:1,legs:[from,{type:"walk" as const,fromStopId:"B",toStopId:"X",departSecs:300,arriveSecs:320},{...to,fromStopId:"X",departSecs:700}]};
  const output=await composeSearchResults({itineraries:[planned],entryWalks:[{stopId:"A",walkSecs:0,distanceMeters:0}],exitWalks:[{stopId:"C",walkSecs:0,distanceMeters:0}],departureSecs:0,
   stops:[{id:"B",lat:54,lon:25},{id:"X",lat:54,lon:25.001}],walkSpeedMps:1.25,walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120},async()=>{
    await Promise.resolve();index.transferRules.set(transferRuleKey("B","X"),{type:3});return {coords:[[25,54],[25.001,54]],distanceMeters:100,steps:[]};
   },()=>null,(a,b)=>effectiveTransferFloor(index,a,b,120),r=>{record=r;},undefined,()=>captureTransferFloorState(index));
  expect(output).toEqual([]);expect(record.finalization.floorRules?.stop?.[0][1].type).toBe(3);expect(replayFinalization(record.finalization)).toEqual([]);
 });
 it("refuses duplicate keys and non-finite rule values",()=>{
  const snapshot=clone(captureTransferFloorState(state()));snapshot.stop!.push(snapshot.stop![0]);expect(()=>restoreTransferFloorState(snapshot)).toThrow("duplicate");
  expect(()=>captureTransferFloorState({transferRules:new Map([["x",{type:2,minSecs:Infinity}]])})).toThrow("finite JSON");
 });
});
