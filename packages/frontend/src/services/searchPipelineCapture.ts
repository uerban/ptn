import type {RaptorQuery, RaptorItinerary} from "@pt/shared";
import {riderWalkSpeedMps, minTransferSecsFor} from "@pt/shared/routing";
import type {SearchQuery} from "./searchOrchestrator.ts";
import type {WalkRoute} from "./walkGraphClient.ts";
import {directWalkCandidate} from "./directWalkCandidate.ts";
import {replayReachableStops, type ReachCapture} from "./searchReachCapture.ts";
import {replaySearchComposition, type CompositionCapture} from "./searchComposition.ts";
import {unixToServiceDate, unixToGtfsSecs} from "@pt/shared/time";
import {wire, same, freeze} from "./searchEvidenceWire.ts";

type Query = Omit<SearchQuery, "departureTime"> & {departureTimeMs: number};
type Planner = {source: "on-device" | "injected"; query: RaptorQuery; serviceDate: string; output: RaptorItinerary[]};
const MISSING = ["endpoint selection and readiness wait before reach", "original planner/service eligibility execution and artifacts",
  "raw pedestrian graphs and provider execution", "raw RT feeds before lookup", "original producer module/runtime identity"];
export type CapturedTimeFrame = {departureUnix: number; serviceDate: string; departureSecs: number; timeOriginUnix: number} & (
  {kind: "timezone"; timeZone: string} | {kind: "engine"});
export interface PipelineCapture {
  format: "ptn-search-pipeline";
  version: 1;
  scope: "frontend linked stages with observed planner";
  classification: "partial capture";
  normalization: "finite-json-wire-v1";
  query: Query;
  /** Absent in legacy v1 observations, whose clock conversion is unverified. */
  timeFrame?: CapturedTimeFrame;
  reach: {entry: ReachCapture; exit: ReachCapture};
  directRoute: WalkRoute | null;
  /** Null means no planner invocation because an endpoint had no reachable stops. */
  planner: Planner | null;
  composition: CompositionCapture;
  output: CompositionCapture["output"];
  missingDependencies: string[];
}

/** Per invocation: overlapping searches never install observers by mutating
 * shared orchestrator configuration. */
export class SearchPipelineCapture {
  private query: Query;
  private frame?: CapturedTimeFrame;
  private entry?: ReachCapture;
  private exit?: ReachCapture;
  private route: WalkRoute | null = null;
  private planner: Planner | null = null;
  private composed?: CompositionCapture;
  constructor(query: SearchQuery, private emit: (record: PipelineCapture) => void) {
    const {departureTime, ...rest} = query;
    this.query = wire({...rest, departureTimeMs: departureTime.getTime()});
  }
  timeFrame(frame: CapturedTimeFrame) {this.frame = wire(frame);}
  reach(side: "entry" | "exit", record: ReachCapture) { this[side] = record; }
  direct(route: WalkRoute | null) { this.route = wire(route); }
  planStart(query: RaptorQuery, serviceDate: string, source: Planner["source"]) {
    this.planner = wire({query, serviceDate, source, output: []});
  }
  planEnd(output: RaptorItinerary[]) {
    if (!this.planner) throw new Error("Missing planner observation");
    this.planner.output = wire(output);
  }
  composition(record: CompositionCapture) { this.composed = record; }
  finish(output: CompositionCapture["output"]) {
    if (!this.entry || !this.exit || !this.composed || !this.frame) throw new Error("Incomplete search stage observations");
    this.emit(freeze(wire({format: "ptn-search-pipeline", version: 1, scope: "frontend linked stages with observed planner",
      classification: "partial capture", normalization: "finite-json-wire-v1", query: this.query, timeFrame: this.frame,
      reach: {entry: this.entry, exit: this.exit}, directRoute: this.route, planner: this.planner,
      composition: this.composed, output, missingDependencies: MISSING})));
  }
}

/** Planner execution and service eligibility remain observed here. Captured
 * timezone frames are recomputed; engine frames need supplied-state replay. */
export async function replaySearchPipeline(record: PipelineCapture): Promise<CompositionCapture["output"]> {
  record = wire(record);
  if (record.format !== "ptn-search-pipeline" || record.version !== 1 || record.scope !== "frontend linked stages with observed planner"
    || record.classification !== "partial capture" || record.normalization !== "finite-json-wire-v1"
    || !Number.isFinite(record.query.departureTimeMs)) throw new Error("Unsupported search pipeline capture");
  const check = (a: unknown, b: unknown, stage: string) => {if (!same(a, b)) throw new Error(`Search stage mismatch: ${stage}`);};
  const {query, reach, composition, planner} = record;
  const [entry, exit] = await Promise.all([replayReachableStops(reach.entry), replayReachableStops(reach.exit)]);
  const input = composition.input;
  if (record.timeFrame !== undefined) {
    const frame = record.timeFrame;
    if (!frame || !Number.isFinite(frame.departureUnix) || !Number.isFinite(frame.timeOriginUnix) || !Number.isFinite(frame.departureSecs)
      || typeof frame.serviceDate !== "string" || !/^\d{8}$/.test(frame.serviceDate)) throw new Error("Unsupported time frame");
    check(frame.departureUnix, Math.floor(query.departureTimeMs / 1000), "query clock");
    check(frame.departureUnix, frame.timeOriginUnix + frame.departureSecs, "time origin");
    check(frame.departureSecs, input.departureSecs, "composition time frame");
    check(frame.kind, planner?.source === "on-device" ? "engine" : "timezone", "time resolver source");
    if (planner) check(frame.serviceDate, planner.serviceDate, "planner service date");
    if (frame.kind === "timezone") {
      if (typeof frame.timeZone !== "string" || !frame.timeZone) throw new Error("Missing captured time zone");
      const date = unixToServiceDate(frame.departureUnix, frame.timeZone);
      check(String(date), frame.serviceDate, "timezone service date");
      check(unixToGtfsSecs(frame.departureUnix, date, frame.timeZone), frame.departureSecs, "timezone departure");
    } else if (frame.kind !== "engine" || !/^\d{8}$/.test(frame.serviceDate)) throw new Error("Unsupported time frame");
  }
  check(reach.entry.input.origin, query.origin, "origin");
  check(reach.exit.input.origin, query.destination, "destination");
  check(reach.entry.input.options.role, "origin", "entry direction");
  check(reach.exit.input.options.role, "destination", "exit direction");
  check(reach.entry.input.options.originStopId, query.originStopId, "origin stop");
  check(reach.exit.input.options.destStopId, query.destStopId, "destination stop");
  check(reach.entry.input.options.originStopIds, query.originStopIds, "origin group");
  check(reach.exit.input.options.destStopIds, query.destStopIds, "destination group");
  const geometry = (stops: {id: string; lat: number; lon: number}[]) => stops.map(({id, lat, lon}) => ({id, lat, lon}));
  check(geometry(reach.entry.input.stops), geometry(reach.exit.input.stops), "reach stop universe");
  check(geometry(input.stops), geometry(reach.entry.input.stops), "composition stop universe");
  check(reach.entry.input.profile, reach.exit.input.profile, "mobility profile");
  for (const key of ["maxWalkSecs", "walkSpeedMps", "radiusMeters", "runToCatch"] as const) check(reach.entry.input.options[key], reach.exit.input.options[key], `reach ${key}`);
  check(input.walkSpeedMps, riderWalkSpeedMps(reach.entry.input.profile, reach.entry.input.options.walkSpeedMps), "walk pace");
  check(input.minTransferSecs, minTransferSecsFor(reach.entry.input.profile), "transfer floor");
  check(input.ranking, query.ranking, "ranking");
  check(input.entryWalks, entry.map(s => ({stopId: s.stopId, walkSecs: s.walkSecs, distanceMeters: s.distanceMeters,
    ...(s.runToCatch ? {runToCatch: true} : {})})), "entry walks");
  check(input.exitWalks, exit.map(s => ({stopId: s.stopId, walkSecs: s.walkSecs, distanceMeters: s.distanceMeters})), "exit walks");
  if (!entry.length || !exit.length) {
    check(planner, null, "skipped planner");check(input.itineraries, [], "no endpoint transit");
  } else {
    if (!planner || !["on-device", "injected"].includes(planner.source) || typeof planner.serviceDate !== "string" || !/^\d{8}$/.test(planner.serviceDate)) throw new Error("Missing planner observation");
    check(planner.query.entryStops, entry.map(({stopId, walkSecs}) => ({stopId, walkSecs})), "planner entry");
    check(planner.query.exitStops, exit.map(({stopId, walkSecs}) => ({stopId, walkSecs})), "planner exit");
    check(planner.query.departureSecs, input.departureSecs, "planner departure");
    check(planner.query.walkSpeedMps, input.walkSpeedMps, "planner walk pace");
    check(planner.query.minTransferSecs, input.minTransferSecs, "planner transfer floor");
    check(planner.query.mobilityProfile ?? "default", reach.entry.input.profile, "planner mobility");
    check(planner.query.maxRounds, query.maxRounds, "planner rounds");
    check(planner.output, input.itineraries, "planner output");
  }
  check(input.walking, directWalkCandidate(query.origin, query.destination, record.directRoute, input.departureSecs, input.walkSpeedMps), "direct walking");
  const output = (await replaySearchComposition(composition)).slice(0, input.maxResults);
  check(output, record.output, "returned output");
  return output;
}
