// Existing native certificate/cache only; no route rule or pruning is added.
import {validateInput,checkSample,timingSummary} from "./progressive_winner_kernel.mjs";
import {winnerStable,checkWinnerResult} from "./winner_browser_kernel.mjs";
import {canonical,percentile} from "./deadline_browser_kernel.mjs";
export const CERTIFICATES=["duration","timetable"],SETUPS=["rebuild","prepared"],MODES=["materialized","materialized-date-memo"];
const same=(a,b)=>canonical(a)===canonical(b),integer=n=>Number.isSafeInteger(n)&&n>=0,finite=n=>Number.isFinite(n)&&n>=0;
const keys=(o,k)=>o&&same(Object.keys(o).sort(),[...k].sort());
const timetableKeys=["enabled","eventScans","walkingProposals","profileChecks","retainedLabels","indexBytes","work"];
export function timetableBytes(numStops,rounds,labels,pointerBytes){
  return numStops*8+rounds*2*pointerBytes+rounds*numStops*2*pointerBytes+labels*16;
}
export function basePrefixBytes(numStops,rounds,pointerBytes){return 3*rounds*(3*pointerBytes+numStops*8);}
export function validatePrefixInput(x){
  if(!CERTIFICATES.includes(x.certificate)||!SETUPS.includes(x.setup)||x.policy!=="fresh"
      ||!MODES.includes(x.options?.witnessComparison)||!integer(x.numStops)||x.numStops<1||x.numStops>4294967295
      ||x.options.prefixCertificate!==x.certificate||x.options.prefixSetup!==x.setup)throw Error("invalid prefix composition workload");
  const options={...x.options,witnessComparison:"materialized-date-memo"};delete options.prefixCertificate;delete options.prefixSetup;
  validateInput({...x,options}); // Original cap/selector/tuple checks remain strict.
  for(const list of[x.latest,x.portfolio])for(const q of list){
    if(q.status==="failed")continue;
    const t=q.timetablePrefix,c=q.counters;
    if(x.certificate==="duration"?t!==undefined:(!keys(t,timetableKeys)||t.enabled!==c.prefixEnabled
        ||timetableKeys.filter(k=>k!=="enabled").some(k=>!integer(t[k]))
        ||t.work!==t.eventScans+t.walkingProposals+t.profileChecks
        ||!t.enabled&&timetableKeys.filter(k=>k!=="enabled").some(k=>t[k]!==0)
        ||t.retainedLabels>t.walkingProposals||t.enabled&&t.eventScans!==c.prefixEventScans
        ||t.indexBytes!==(t.enabled?timetableBytes(x.numStops,x.maxRounds,t.retainedLabels,8):0)))throw Error("native timetable reference metadata/work/storage drift");
    if(c.stopWork!==c.seedEventChecks+c.stopEventsScanned+c.prefixEventScans+c.prefixWalkingRelaxations+(t?.work??0)
        ||c.stopWork>x.options.maxStopScans||c.lookupWork>x.options.maxLookupWork)throw Error("native original aggregate cap drift");
  }
}
export function prefixStable(r){
  return{...winnerStable(r),witnessDateMemoStackBytes:r.witnessDateMemoStackBytes,
    ...(Object.hasOwn(r,"prefixExperiment")?{prefixExperiment:r.prefixExperiment}:{})};
}
export function checkPrefixStage(payload,input,i,goal){
  const q=(goal==="portfolio"?input.portfolio:input.latest)[i],r=payload.result,p=payload.prepared;
  const advanced=input.certificate!=="duration"||input.setup!=="rebuild",extra=advanced?["prefixExperiment"]:[];
  if(q.status!=="completed"||!keys(r,[...Object.keys(winnerStable({})),"witnessDateMemoStackBytes","prepareMs","searchMs","coreMs",...extra])
      ||!keys(p,["eventCount","eventIndexBytes","peakBuildBytes","catalogueMode","catalogueReused","catalogueKey","lookupMode","traversalMode","witnessComparison","frontierStorage","staticBound","walkingBound","forwardSeeds",...extra])
      ||[p.eventCount,p.eventIndexBytes,p.peakBuildBytes].some(n=>!integer(n))||p.peakBuildBytes<p.eventIndexBytes
      ||r.witnessDateMemoStackBytes!==64||!finite(payload.callMs)||!finite(payload.preparationMs)||r.coreMs>payload.callMs+.1)throw Error("prefix binding/schema/phase drift");
  const c=r.counters,t=q.timetablePrefix,work=t?.work??0;
  if(c.stopWork>input.options.maxStopScans||c.stopWork!==q.counters.stopWork
      ||c.stopWork!==c.seedEventChecks+c.stopEventsScanned+c.prefixEventScans+c.prefixWalkingRelaxations+work)throw Error("prefix original stop-work charge/cap drift");
  if(advanced){
    const a=r.prefixExperiment,tt=a?.timetable,ttBytes=t?.enabled?timetableBytes(input.numStops,input.maxRounds,t.retainedLabels,4):0;
    const expected=t?{...t,indexBytes:ttBytes}:{enabled:false,eventScans:0,walkingProposals:0,profileChecks:0,retainedLabels:0,indexBytes:0,work:0};
    if(!same(p.prefixExperiment,{certificate:input.certificate,setup:input.setup})
        ||!keys(a,["certificate","setup","enabled","indexBytes","nominalStopWork","timetable"])
        ||a.certificate!==input.certificate||a.setup!==input.setup||a.enabled!==c.prefixEnabled||!same(tt,expected)
        ||a.nominalStopWork!==c.prefixEventScans+c.prefixWalkingRelaxations+work
        ||a.indexBytes!==(a.enabled?basePrefixBytes(input.numStops,input.maxRounds,4)+ttBytes:0))throw Error("prefix M32 payload or retained nominal work drift");
  }
  // The additional charge and true aggregate cap were checked above. Adapt only
  // that explicit delta for the unchanged duration-only legacy work equation.
  const normalized={...r,counters:{...c,stopWork:c.stopWork-work}};
  const expected={...q,counters:{...q.counters,stopWork:q.counters.stopWork-work}};
  checkWinnerResult(normalized,p,expected,{goal,validation:"session",options:input.options});
}
export const retirementKeys=["retirementWorkerMs","retirementRoundtripMs","retirementStartMs","requestWithRetirementMs","afterRetirementLinearBytes"];
export function checkPrefixSample(s,sequence){
  const normalized={...s};for(const k of retirementKeys)delete normalized[k];checkSample(normalized,sequence);
  if(retirementKeys.some(k=>!finite(s[k]))||s.retirementWorkerMs>s.retirementRoundtripMs+1||s.retirementStartMs<s.requestDoneMs
      ||Math.abs(s.requestWithRetirementMs-s.retirementStartMs-s.retirementRoundtripMs)>1e-6
      ||!integer(s.afterRetirementLinearBytes)||s.afterRetirementLinearBytes<s.afterLinearBytes||s.afterRetirementLinearBytes%65536)
    throw Error("prefix retirement/lifetime accounting drift");
}
export function prefixTimingSummary(samples){
  return{...timingSummary(samples),requestWithRetirementMs:{p50Ms:percentile(samples.map(s=>s.requestWithRetirementMs),.5),p95Ms:percentile(samples.map(s=>s.requestWithRetirementMs),.95)}};
}
