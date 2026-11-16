import { describe, it, expect } from "vitest";
import { directWalkCandidate } from "../../src/services/directWalkCandidate.ts";
const point = {lat:54.68,lon:25.28};
const route = {coords:[[25.28,54.68],[25.2801,54.68]] as [number,number][],distanceMeters:15,steps:[]};
describe("routed direct-walking candidate", () => {
 it("retains physical distance while pace changes arrival", () => {
  const normal=directWalkCandidate(point,point,route,28800,1.5)!;
  const slow=directWalkCandidate(point,point,route,28800,0.75)!;
  expect(normal.arrivalSecs).toBe(28810);
  expect(slow.arrivalSecs).toBe(28820);
  expect(slow.totalWalkMeters).toBe(15);
  expect(normal.transfers).toBe(0);
 });
 it("does not fabricate missing pedestrian evidence", () => {
  expect(directWalkCandidate(point,point,null,28800,1.5)).toBeNull();
  expect(directWalkCandidate(point,point,{...route,coords:[]},28800,1.5)).toBeNull();
 });
 it("accepts routed zero distance and rejects invalid pace", () => {
  expect(directWalkCandidate(point,point,{...route,distanceMeters:0},28800,1.5)?.totalSecs).toBe(0);
  expect(directWalkCandidate(point,point,route,28800,0)).toBeNull();
 });
});
