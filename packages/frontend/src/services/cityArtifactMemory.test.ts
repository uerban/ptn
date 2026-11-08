import {afterEach, expect, it} from "vitest";
import type {CityArtifactRecord} from "../db/index.ts";
import {CITY_ARTIFACT_MEMORY_BYTES, clearCityArtifactMemory, recalledCityArtifact, rememberCityArtifact} from "./cityArtifactMemory.ts";
import {clearSharedArtifactMemory} from "./sharedCityArtifacts.ts";

const binary = (key: string, size = 1) => ({key, ptb: {bytes: new Uint8Array(size)}} as CityArtifactRecord);
afterEach(clearCityArtifactMemory);

it("retains two recent binary generations, without retaining every visited city", () => {
  const a = binary("a"), b = binary("b"), c = binary("c");
  rememberCityArtifact(a); rememberCityArtifact(b);
  expect(recalledCityArtifact("a")).toBe(a);
  rememberCityArtifact(c);
  expect(recalledCityArtifact("b")).toBeUndefined();
  expect(recalledCityArtifact("a")).toBe(a);
  expect(recalledCityArtifact("c")).toBe(c);
});

it("bounds retained bytes even when individual city feeds are large", () => {
  const a = binary("a", CITY_ARTIFACT_MEMORY_BYTES / 2 + 1);
  const b = binary("b", CITY_ARTIFACT_MEMORY_BYTES / 2 + 1);
  rememberCityArtifact(a); rememberCityArtifact(b);
  expect(recalledCityArtifact("a")).toBeUndefined();
  expect(recalledCityArtifact("b")).toBe(b);
  rememberCityArtifact(binary("oversized", CITY_ARTIFACT_MEMORY_BYTES + 1));
  expect(recalledCityArtifact("oversized")).toBeUndefined();
  expect(recalledCityArtifact("b")).toBe(b);
});

it("invalidates binary entries when downloaded cache memory is cleared", () => {
  rememberCityArtifact(binary("a"));
  clearSharedArtifactMemory();
  expect(recalledCityArtifact("a")).toBeUndefined();
});
