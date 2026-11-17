import {wire, same, freeze} from "./searchEvidenceWire.ts";
import type { RankingCriteria, RaptorTransitLeg } from "@pt/shared";
import { rankResults } from "./raptorComposer.ts";
import { applyRtOverlay, type RtComposedItinerary } from "./rtOverlay.ts";
import { feasibleRtCandidates } from "./rtFeasibility.ts";

type DelayLookup = Parameters<typeof applyRtOverlay>[1];
type Floor = (from: RaptorTransitLeg, to: RaptorTransitLeg) => number | null;
export interface FinalizationInput {
  composed: RtComposedItinerary[];
  walking: RtComposedItinerary | null;
  ranking: RankingCriteria;
  maxResults: number;
  minTransferSecs: number;
}
type Read = { kind: "delay"; tripId: string; value: ReturnType<DelayLookup> }
  | { kind: "floor"; from: RaptorTransitLeg; to: RaptorTransitLeg; value: number | null };
export interface FinalizationCapture {
  format: "ptn-search-finalization";
  version: 1;
  scope: "frontend RT feasibility and ranking";
  classification: "partial capture";
  normalization: "finite-json-wire-v1";
  nowMs: number;
  input: FinalizationInput;
  reads: Read[];
  hasTransferFloor: boolean;
  output: RtComposedItinerary[];
  missingDependencies: string[];
}
const MISSING = ["application/runtime module bytes", "upstream endpoint reach and planner execution",
  "raw pedestrian graph and route execution", "raw RT feeds before lookup"];

function run(input: FinalizationInput, delay: DelayLookup, floor: Floor | undefined, nowMs: number): RtComposedItinerary[] {
  const withRt = applyRtOverlay(input.composed, delay, input.minTransferSecs, floor, nowMs);
  const feasible = feasibleRtCandidates(withRt, floor);
  return rankResults(input.walking ? [...feasible, input.walking] : feasible, input.ranking).slice(0, input.maxResults);
}

function validateInput(input: FinalizationInput): void {
  if (!input || !Array.isArray(input.composed) || !["fastest", "least_walking", "fewest_transfers"].includes(input.ranking)
      || !Number.isInteger(input.maxResults) || input.maxResults < 0
      || !Number.isFinite(input.minTransferSecs) || input.minTransferSecs < 0) throw new Error("Unsupported finalization inputs");
}

/** Capture is off by default. The observer receives an immutable local record;
 * no persistence, upload, provider request or baseline promotion occurs here. */
export function finalizeSearch(input: FinalizationInput, delay: DelayLookup, floor?: Floor,
  capture?: (record: FinalizationCapture) => void): RtComposedItinerary[] {
  const nowMs = Date.now();
  if (!capture) return run(input, delay, floor, nowMs);
  validateInput(input);
  const retained = wire(input), reads: Read[] = [];
  const observedDelay: DelayLookup = tripId => {
    const value = wire(delay(tripId)); reads.push({kind: "delay", tripId, value}); return value;
  };
  const observedFloor: Floor | undefined = floor ? (from, to) => {
    const value = floor(from, to); reads.push(wire({kind: "floor", from, to, value})); return value;
  } : undefined;
  const output = run(input, observedDelay, observedFloor, nowMs);
  capture(freeze(wire<FinalizationCapture>({format: "ptn-search-finalization", version: 1,
    scope: "frontend RT feasibility and ranking", classification: "partial capture", normalization: "finite-json-wire-v1",
    nowMs, input: retained, reads, hasTransferFloor: !!floor, output,
    missingDependencies: MISSING})));
  return output;
}

/** Replay only the declared finalization boundary. Every lookup argument/order
 * and every output JSON field must match; leftover evidence is an error. */
export function replayFinalization(source: FinalizationCapture): RtComposedItinerary[] {
  const record = wire(source);
  if (record.format !== "ptn-search-finalization" || record.version !== 1 || record.scope !== "frontend RT feasibility and ranking"
      || record.classification !== "partial capture" || record.normalization !== "finite-json-wire-v1"
      || !Number.isFinite(record.nowMs) || !Array.isArray(record.reads) || typeof record.hasTransferFloor !== "boolean"
      || !same(record.missingDependencies, MISSING)) throw new Error("Unsupported finalization capture");
  validateInput(record.input);
  let index = 0;
  const take = (expected: Omit<Extract<Read, {kind: "delay"}>, "value"> | Omit<Extract<Read, {kind: "floor"}>, "value">): Read => {
    const read = record.reads[index++];
    if (!read) throw new Error("Missing finalization lookup evidence");
    const {value: _value, ...args} = read;
    if (!same(args, expected)) throw new Error("Finalization lookup order or arguments changed");
    return read;
  };
  const delay: DelayLookup = tripId => (take({kind: "delay", tripId}) as Extract<Read, {kind: "delay"}>).value;
  const floor: Floor | undefined = record.hasTransferFloor ? (from, to) => (take({kind: "floor", from, to}) as Extract<Read, {kind: "floor"}>).value : undefined;
  const output = run(record.input, delay, floor, record.nowMs);
  if (index !== record.reads.length || !same(wire(output), record.output)) throw new Error("Finalization output or lookup count changed");
  return output;
}
