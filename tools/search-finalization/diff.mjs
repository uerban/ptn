import {normalize,changedFields,difference} from "../../crates/pt-wasm/tests/baseline_diff.mjs";
import {inspectFinalizationCapsule} from "./capsule.mjs";
const common=["format","version","scope","classification","normalization","output","missingDependencies"];
function known(value,keys,path) {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Unsupported capture at ${path}`);
  const unknown=Object.keys(value).filter(key=>!keys.includes(key));
  if(unknown.length)throw new Error(`Unsupported capture fields at ${path}: ${unknown.join(", ")}`);
}
function validate(record,path="record") {
  const fields={
    "ptn-search-finalization":["nowMs","input","reads","hasTransferFloor","floorRules"],
    "ptn-search-reach":["input","hasTransferLookup","reads"],
    "ptn-search-composition":["nowMs","input","reads","hasPedestrianProvider","finalization"],
    "ptn-search-pipeline":["query","timeFrame","reach","directRoute","planner","composition"],
  };
  if(!fields[record?.format])throw new Error("Unsupported capture format");
  known(record,[...common,...fields[record.format]],path);
  if(record.format==="ptn-search-reach")for(const read of record.reads) {
    const keys={ready:["kind","value"],table:["kind","sources","destinations","value"],transfer:["kind","from","to","value"]};
    if(!keys[read.kind])throw new Error("Unsupported reach lookup kind");known(read,keys[read.kind],path+".reads");
  }
  if(record.format==="ptn-search-finalization")for(const read of record.reads) {
    if(read.kind!=="delay"&&read.kind!=="floor")throw new Error("Unsupported finalization lookup kind");
    known(read,read.kind==="delay"?["kind","tripId","value"]:["kind","from","to","value"],path+".reads");
  }
  if(record.format==="ptn-search-composition") {
    for(const read of record.reads) {
      if(!["route","unavailable"].includes(read.outcome))throw new Error("Unsupported pedestrian lookup outcome");
      known(read,read.outcome==="route"?["from","to","outcome","route"]:["from","to","outcome","cityId","reason"],path+".reads");
    }
    validate(record.finalization,path+".finalization");
  }
  if(record.format==="ptn-search-pipeline") {
    known(record.reach,["entry","exit"],path+".reach");
    validate(record.reach.entry,path+".reach.entry");validate(record.reach.exit,path+".reach.exit");validate(record.composition,path+".composition");
    if(record.planner) {
      known(record.planner,["source","query","serviceDate","output"],path+".planner");
      known(record.planner.query,["entryStops","exitStops","departureSecs","activeServiceIds","maxRounds","mobilityProfile","excludedModes","excludedRouteIds","walkSpeedMps","minTransferSecs"],path+".planner.query");
    }
    if(Object.hasOwn(record,"timeFrame")) {
      known(record.timeFrame,["kind","departureUnix","serviceDate","departureSecs","timeOriginUnix","timeZone"],path+".timeFrame");
      if(!["timezone","engine"].includes(record.timeFrame.kind))throw new Error("Unsupported time frame kind");
    }
  }
}
function contract(snapshot) {
  const {capsule,record,rtEvents}=snapshot;
  known(capsule,["schemaVersion","format","scope","classification","replayVerification","artifacts","replayRuntime","recordProducerIdentity","missingDependencies","plannerExecution","walkingExecution","rtExecution"],"capsule");
  validate(record);
  for(const [field,keys] of Object.entries({plannerExecution:["version","patternMode","transfers","originalHandleIdentity"],walkingExecution:["version","cityId","profile","originalGraphIdentity"],rtExecution:["version","originalRtIdentity"]}))if(capsule[field])known(capsule[field],keys,field);
  const finalization=record.format==="ptn-search-finalization"?record:record.format==="ptn-search-composition"?record.finalization:record.composition?.finalization;
  const composition=record.format==="ptn-search-composition"?record:record.composition;
  const rt=capsule.rtExecution?{mode:"supplied frontend envelopes",version:capsule.rtExecution.version,events:rtEvents}
    :{mode:"observed delay transcript",reads:finalization?.reads.filter(read=>read.kind==="delay")};
  // Floor lookups are still external observations, even with planner state.
  const floor=finalization?.floorRules?{mode:"captured transfer rules",state:finalization.floorRules}
    :{mode:"observed floor transcript",present:finalization?.hasTransferFloor,reads:finalization?.reads.filter(read=>read.kind==="floor"),
      ...(finalization?.hasTransferFloor?{lookupOrder:finalization.reads.map(read=>read.kind)}:{})};
  const walk=capsule.walkingExecution?{mode:"supplied decoded graph",version:capsule.walkingExecution.version,graph:capsule.artifacts.walkingGraph,
    city:capsule.walkingExecution.cityId,profile:capsule.walkingExecution.profile}
    :{mode:"observed pedestrian transcript",present:composition?.hasPedestrianProvider,reads:composition?.reads,...(record.format==="ptn-search-pipeline"?{directRoute:record.directRoute}:{})};
  const base={format:record.format,version:record.version,scope:capsule.scope,normalization:record.normalization,runtime:capsule.replayRuntime};
  if(record.format==="ptn-search-reach")return {...base,input:record.input,lookup:record.hasTransferLookup,reads:record.reads};
  if(record.format==="ptn-search-finalization")return {...base,input:record.input,nowMs:record.nowMs,rt,floor};
  if(record.format==="ptn-search-composition")return {...base,input:record.input,nowMs:{composition:record.nowMs,finalization:finalization.nowMs},rt,floor,walk};
  const planner=capsule.plannerExecution?{mode:"supplied planner",version:capsule.plannerExecution.version,ptb:capsule.artifacts.plannerPtb,
    transfers:capsule.plannerExecution.transfers?capsule.artifacts.plannerTransfers:null,patternMode:capsule.plannerExecution.patternMode,
    source:record.planner?.source,excludedModes:record.planner?.query.excludedModes,excludedRouteIds:record.planner?.query.excludedRouteIds}
    :{mode:"observed planner",value:record.planner};
  const timeFrame=record.timeFrame?record.timeFrame.kind==="timezone"?{kind:"timezone",unix:record.timeFrame.departureUnix,zone:record.timeFrame.timeZone}
    :capsule.plannerExecution?{kind:"supplied engine",unix:record.timeFrame.departureUnix}:{kind:"observed engine",frame:record.timeFrame}
    :{kind:"legacy clock conversion unverified",serviceDate:record.planner?.serviceDate,departureSecs:composition.input.departureSecs};
  return {...base,query:record.query,reach:{entry:{input:record.reach.entry.input,lookup:record.reach.entry.hasTransferLookup,reads:record.reach.entry.reads},
    exit:{input:record.reach.exit.input,lookup:record.reach.exit.hasTransferLookup,reads:record.reach.exit.reads}},
    timeFrame,planner,walk,rt,floor,nowMs:{composition:composition.nowMs,finalization:finalization.nowMs},settings:{maxResults:composition.input.maxResults,
      ...(capsule.plannerExecution?{}:{minTransferSecs:composition.input.minTransferSecs,walkSpeedMps:composition.input.walkSpeedMps})}};
}
const codeKeys=["module","replayChild","plannerWasm","plannerGlue","walkingWasm","walkingGlue","rtModule","walkingRequestBuilder","rtRequestBuilder"];
function summary(snapshot) {
  return {manifestSha256:snapshot.manifestSha256,recordSha256:snapshot.capsule.artifacts.record,scope:snapshot.capsule.scope,
    classification:snapshot.capsule.classification,recordProducerIdentity:snapshot.capsule.recordProducerIdentity,
    replayRuntime:snapshot.capsule.replayRuntime,declaredMissingDependencies:snapshot.capsule.missingDependencies,observationMissingDependencies:snapshot.record.missingDependencies,
    code:Object.fromEntries(codeKeys.filter(key=>snapshot.capsule.artifacts[key]).map(key=>[key,snapshot.capsule.artifacts[key]]))};
}
/** Read-only and non-executing. Comparability concerns the declared retained
 * input contract; independent replay verification and human quality stay separate. */
export function diffFinalizationCapsules(beforeStore,beforeId,afterStore,afterId) {
  const before=inspectFinalizationCapsule(beforeStore,beforeId),after=inspectFinalizationCapsule(afterStore,afterId);
  const left=before.record.output,right=after.record.output;
  const added=difference(right,left),removed=difference(left,right),fields=changedFields(left,right);
  const result={format:"ptn-search-capsule-diff",version:1,normalizerVersion:1,qualityVerdict:null,replayVerification:"not evaluated by diff",
    before:summary(before),after:summary(after),codeChanges:changedFields(summary(before).code,summary(after).code),
    beforeOutput:left,afterOutput:right,added,removed,orderingOnly:fields.length>0&&!added.length&&!removed.length,fieldChanges:fields};
  let inputChanges;
  try {inputChanges=changedFields(normalize(contract(before)),normalize(contract(after)));}
  catch(error){return {...result,status:"incomparable",reason:error.message,inputChanges:[]};}
  if(inputChanges.length)return {...result,status:"incomparable",reason:"mismatched retained inputs or dependency coverage",inputChanges};
  return {...result,status:fields.length?"changed/unreviewed":"unchanged",inputChanges:[]};
}
