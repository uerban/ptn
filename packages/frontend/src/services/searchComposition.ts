import type {TransferFloorState} from "./transferFloorState.ts";
import type {LatLon, RaptorItinerary, RankingCriteria} from "@pt/shared";
import type {WalkRoute} from "./walkGraphClient.ts";
import {WalkGraphUnavailableError} from "./walkGraphAvailability.ts";
import {transferWalkEvidence} from "./transferWalkEvidence.ts";
import {composeItineraries} from "./raptorComposer.ts";
import {finalizeSearch, replayFinalization, type FinalizationCapture} from "./searchFinalization.ts";
import type {RtComposedItinerary} from "./rtOverlay.ts";
import {wire, same, freeze} from "./searchEvidenceWire.ts";

export interface CompositionInput {
  itineraries: RaptorItinerary[];
  entryWalks: Parameters<typeof composeItineraries>[1];
  exitWalks: Parameters<typeof composeItineraries>[2];
  departureSecs: number;
  stops: {id: string; lat: number; lon: number}[];
  walkSpeedMps: number;
  walking: RtComposedItinerary | null;
  ranking: RankingCriteria;
  maxResults: number;
  minTransferSecs: number;
}
type RouteFor = (from: LatLon, to: LatLon) => Promise<WalkRoute | null>;
type PedestrianRead = {from: LatLon; to: LatLon} & (
  {outcome: "route"; route: WalkRoute | null}
  | {outcome: "unavailable"; cityId: string; reason: "transient" | "superseded"});
const MISSING = ["endpoint and direct-walk construction before planner output", "planner/timetable execution artifacts",
  "raw pedestrian graph and route execution", "raw RT feeds before lookup", "original producer module/runtime identity"];
export interface CompositionCapture {
  format: "ptn-search-composition";
  version: 1;
  scope: "frontend post-planner walking composition";
  classification: "partial capture";
  normalization: "finite-json-wire-v1";
  nowMs: number;
  input: CompositionInput;
  hasPedestrianProvider: boolean;
  reads: PedestrianRead[];
  finalization: FinalizationCapture;
  output: RtComposedItinerary[];
  missingDependencies: string[];
}

async function composed(input: CompositionInput, routeFor?: RouteFor) {
  if (!input.itineraries.length) return [];
  const evidenced = routeFor && input.itineraries.length
    ? await transferWalkEvidence(input.itineraries, input.stops, routeFor, input.walkSpeedMps)
    : input.itineraries;
  return composeItineraries(evidenced, input.entryWalks, input.exitWalks, input.departureSecs);
}

/** The live post-planner path and its replay use the same composition functions.
 * Route responses are observations, not proof of an independently valid graph. */
export async function composeSearchResults(input: CompositionInput, routeFor: RouteFor | undefined,
  delay: Parameters<typeof finalizeSearch>[1], floor: Parameters<typeof finalizeSearch>[2],
  capture?: (record: CompositionCapture) => void, finalizationCapture?: (record: FinalizationCapture) => void, floorState?: () => TransferFloorState,
): Promise<RtComposedItinerary[]> {
  const consumed = capture ? wire(input) : input, reads: PedestrianRead[] = [];
  const observed: RouteFor | undefined = routeFor && capture ? async (from, to) => {
    const args = wire({from, to});
    try {
      const route = wire(await routeFor(from, to));
      reads.push(wire({...args, outcome: "route", route}));return route;
    } catch (error) {
      if (!(error instanceof WalkGraphUnavailableError)) throw error;
      reads.push(wire({...args, outcome: "unavailable", cityId: error.cityId, reason: error.reason}));throw error;
    }
  } : routeFor;
  const candidates = await composed(consumed, observed);
  let retained: FinalizationCapture | undefined;
  const observer = capture ? (record: FinalizationCapture) => { retained = record; finalizationCapture?.(record); } : finalizationCapture;
  const output = finalizeSearch({composed: candidates, walking: consumed.walking, ranking: consumed.ranking,
    maxResults: consumed.maxResults, minTransferSecs: consumed.minTransferSecs}, delay, floor, observer, floorState);
  if (capture && retained) capture(freeze(wire<CompositionCapture>({format: "ptn-search-composition", version: 1,
    scope: "frontend post-planner walking composition", classification: "partial capture", normalization: "finite-json-wire-v1",
    nowMs: retained.nowMs, input: consumed, hasPedestrianProvider: !!routeFor, reads, finalization: retained,
    output, missingDependencies: MISSING})));
  return output;
}

export async function replaySearchComposition(source: CompositionCapture): Promise<RtComposedItinerary[]> {
  const record = wire(source);
  if (record.format !== "ptn-search-composition" || record.version !== 1 || record.classification !== "partial capture"
    || record.scope !== "frontend post-planner walking composition" || record.normalization !== "finite-json-wire-v1"
    || !Array.isArray(record.reads) || typeof record.hasPedestrianProvider !== "boolean"
    || record.nowMs !== record.finalization?.nowMs || !same(record.missingDependencies, MISSING)) throw new Error("Unsupported composition capture");
  let index = 0;
  const routeFor: RouteFor | undefined = record.hasPedestrianProvider ? async (from, to) => {
    const read = record.reads[index++];
    if (!read || !same({from: read.from, to: read.to}, {from, to})) throw new Error("Pedestrian lookup order or arguments changed");
    if (read.outcome === "route") return read.route;
    if (read.outcome === "unavailable" && typeof read.cityId === "string" && ["transient", "superseded"].includes(read.reason)) throw new WalkGraphUnavailableError(read.cityId, read.reason);
    throw new Error("Unsupported pedestrian observation");
  } : undefined;
  const candidates = await composed(record.input, routeFor);
  const expected = {composed: candidates, walking: record.input.walking, ranking: record.input.ranking,
    maxResults: record.input.maxResults, minTransferSecs: record.input.minTransferSecs};
  if (index !== record.reads.length || !same(expected, record.finalization.input)) throw new Error("Composition or pedestrian lookup count changed");
  const output = replayFinalization(record.finalization);
  if (!same(wire(output), record.output)) throw new Error("Composition output changed");
  return output;
}
