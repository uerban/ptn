import type {MobilityProfile} from "@pt/shared";
import {findReachableStops, type IsochroneOptions} from "./isochrone.ts";
import {wire, same, freeze} from "./searchEvidenceWire.ts";

type Args = Parameters<typeof findReachableStops>;
type Input = {origin: Args[0]; stops: Args[1]; options: Omit<IsochroneOptions, "osmLookup">; profile: MobilityProfile};
type Read = {kind: "ready"; value: boolean}
  | {kind: "table"; sources: Args[0][]; destinations: Args[0][]; value: Awaited<ReturnType<Args[3]["table"]>>}
  | {kind: "transfer"; from: string; to: string; value: number | null};
const MISSING = ["endpoint selection before reach resolution", "OSRM module/graph and transfer-table artifacts",
  "planner execution", "original producer module/runtime identity"];
export interface ReachCapture {
  format: "ptn-search-reach";
  version: 1;
  classification: "partial capture";
  normalization: "finite-json-wire-v1";
  input: Input;
  hasTransferLookup: boolean;
  reads: Read[];
  output: Awaited<ReturnType<typeof findReachableStops>>;
  missingDependencies: string[];
}

/** Local opt-in observation of one directed endpoint reach calculation. Provider
 * responses are retained observations; this does not execute their raw graphs. */
export async function captureReachableStops(...args: [...Args, ((record: ReachCapture) => void)?]): ReturnType<typeof findReachableStops> {
  const [origin, stops, options, osrm, profile, capture] = args;
  if (!capture) return findReachableStops(origin, stops, options, osrm, profile);
  const {osmLookup, ...plainOptions} = options;
  const input = wire({origin, stops, options: plainOptions, profile: profile ?? "default"});
  const reads: Read[] = [];
  const observedOsrm: Args[3] = {
    isReady() {
      const value = osrm.isReady();
      reads.push({kind: "ready", value});
      return value;
    },
    async table(sources, destinations) {
      // Retain invocation order, including when provider promises overlap.
      const read = {kind: "table" as const, ...wire({sources, destinations}), value: null as ReadTableValue};
      reads.push(read);
      read.value = wire(await osrm.table(sources, destinations));
      return read.value;
    },
  };
  const observedLookup = osmLookup && {getWalkSecs(from: string, to: string) {
    const value = osmLookup.getWalkSecs(from, to);
    reads.push(wire({kind: "transfer" as const, from, to, value: value ?? null}));
    return value;
  }};
  const output = await findReachableStops(origin, stops, {...options, osmLookup: observedLookup}, observedOsrm, profile);
  capture(freeze(wire({format: "ptn-search-reach", version: 1, classification: "partial capture",
    normalization: "finite-json-wire-v1", input, hasTransferLookup: !!osmLookup, reads, output, missingDependencies: MISSING})));
  return output;
}
type ReadTableValue = Awaited<ReturnType<Args[3]["table"]>>;

export async function replayReachableStops(record: ReachCapture): ReturnType<typeof findReachableStops> {
  record = wire(record);
  if (record.format !== "ptn-search-reach" || record.version !== 1 || record.classification !== "partial capture"
    || record.normalization !== "finite-json-wire-v1") throw new Error("Unsupported reach capture");
  let cursor = 0;
  const next = (kind: Read["kind"]) => {
    const read = record.reads[cursor++];
    if (!read || read.kind !== kind) throw new Error("Reach lookup order changed");
    return read;
  };
  const osrm: Args[3] = {
    isReady() {
      const read = next("ready");
      if (read.kind !== "ready" || typeof read.value !== "boolean") throw new Error("Invalid reach readiness");
      return read.value;
    },
    async table(sources, destinations) {
      const read = next("table");
      if (read.kind !== "table" || !same({sources, destinations}, {sources: read.sources, destinations: read.destinations})) throw new Error("Reach table arguments changed");
      return read.value;
    },
  };
  const osmLookup = record.hasTransferLookup ? {getWalkSecs(from: string, to: string) {
    const read = next("transfer");
    if (read.kind !== "transfer" || read.from !== from || read.to !== to) throw new Error("Reach transfer arguments changed");
    return read.value === null ? undefined : read.value;
  }} : undefined;
  const {origin, stops, options, profile} = record.input;
  const output = await findReachableStops(origin, stops, {...options, osmLookup}, osrm, profile);
  if (cursor !== record.reads.length || !same(output, record.output)) throw new Error("Reach output or lookup count changed");
  return output;
}
