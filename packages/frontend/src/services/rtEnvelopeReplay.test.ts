import {describe,it,expect} from "vitest";
import {replayRtEnvelopes} from "./rtEnvelopeReplay.ts";
const packet=(hex:string)=>Uint8Array.from(hex.match(/../g)!.map(byte=>parseInt(byte,16)));
const wire=packet("0a0152120a0a015410f001180020011801"); // route R; trip T; +120s; not cancelled; deleted; generatedAt 1.
describe("frontend RouteUpdate history replay",()=>{
 it("decodes independent wire bytes and stamps receipts",()=>{
  expect(replayRtEnvelopes([{kind:"update",bytes:wire,receivedAt:123}],["T","unknown"])).toEqual([{delaySeconds:120,cancelled:false,deleted:true,receivedAt:123},null]);
 });
 it("clamps at the store boundary and keeps first-match route order after removals/reinsertion",()=>{
  const large=packet("0a0152120a0a015410904e180020011801"),other=packet("0a0153120a0a015410f001180020011801");
  const events=[{kind:"update" as const,bytes:large,receivedAt:1},{kind:"update" as const,bytes:other,receivedAt:2}];
  expect(replayRtEnvelopes(events,["T"])[0]?.delaySeconds).toBe(1800);
  expect(replayRtEnvelopes([...events,{kind:"remove",routeIds:["R"]},{kind:"update",bytes:large,receivedAt:3}],["T"])[0]?.receivedAt).toBe(2);
 });
 it("route replacement clears disappeared trips, and invalid protobuf fails",()=>{
  expect(replayRtEnvelopes([{kind:"update",bytes:wire,receivedAt:1},{kind:"update",bytes:packet("0a01521801"),receivedAt:2}],["T"])).toEqual([null]);
  expect(()=>replayRtEnvelopes([{kind:"update",bytes:packet("12ff"),receivedAt:1}],["T"])).toThrow();
 });
});
