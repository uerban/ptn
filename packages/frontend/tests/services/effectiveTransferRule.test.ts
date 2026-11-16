import {it,expect} from "vitest";
import type {RaptorTransitLeg} from "@pt/shared";
import type {RaptorIndex} from "../../src/services/raptorIndex.ts";
import {effectiveTransferFloor} from "../../src/services/effectiveTransferRule.ts";
const leg:RaptorTransitLeg={type:"transit",fromStopId:"A",toStopId:"B",departSecs:0,arriveSecs:10,tripId:"T1",routeId:"R1",boardStopIdx:0,alightStopIdx:1};
const next={...leg,fromStopId:"B",toStopId:"D",tripId:"T2",routeId:"R2"};
const index:RaptorIndex={routes:[],routeIdToIdx:new Map(),routesAtStop:new Map(),services:new Map()};
it("resolves trip, route and stop scope without overriding timed transfers",()=>{
 const scoped={...index,transferRules:new Map([["B\tB",{type:2,minSecs:180}]]),transferRulesRouteScoped:new Map([["B\tB\tR1\tR2",{type:1}]]),transferRulesTripScoped:new Map([["B\tB\tT1\tT2",{type:3}]])};
 expect(effectiveTransferFloor(scoped,leg,next,120)).toBeNull();
 scoped.transferRulesTripScoped.clear();expect(effectiveTransferFloor(scoped,leg,next,120)).toBe(0);
 scoped.transferRulesRouteScoped.clear();expect(effectiveTransferFloor(scoped,leg,next,120)).toBe(180);
 scoped.transferRules.clear();expect(effectiveTransferFloor(scoped,leg,next,120)).toBe(120);
});
it.each([1,4])("waives floor for transfer type %s",type=>{
 expect(effectiveTransferFloor({...index,transferRules:new Map([["B\tB",{type}]])},leg,next,180)).toBe(0);
});


it("does not apply scoped or in-seat rules across a footpath",()=>{
 const cross={...next,fromStopId:"C"};
 expect(effectiveTransferFloor({...index,transferRulesTripScoped:new Map([["B\tC\tT1\tT2",{type:1}]])},leg,cross,120)).toBe(120);
 expect(effectiveTransferFloor({...index,transferRules:new Map([["B\tC",{type:4}]])},leg,cross,120)).toBe(120);
});
