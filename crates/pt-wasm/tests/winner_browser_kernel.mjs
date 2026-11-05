// Isolated exact-winner qualification, not an application planner adapter.
import {canonical,percentile,checkFrontierStats} from "./deadline_browser_kernel.mjs";
export const WINNER_GOALS=["latest-departure","fastest","least-walking","fewest-transfers"];
const same=(a,b)=>canonical(a)===canonical(b),count=n=>Number.isSafeInteger(n)&&n>=0;
const finite=n=>Number.isFinite(n)&&n>=0;
export function nativeSelection(q) {
  return {boundChecks:q.selection.boundChecks,prunedBoardings:q.selection.prunedBoardings,
    suffixBoundChecks:q.suffixSelection.boundChecks,prunedSuffixes:q.suffixSelection.prunedSuffixes,
    predecessorBoundChecks:q.predecessorSelection.boundChecks,prunedPredecessorPairs:q.predecessorSelection.prunedPairs,
    rowBoundChecks:q.rowSelection.boundChecks,skippedRows:q.rowSelection.skippedRows,
    rowCeilingBuilds:q.cutoffSelection.builds,rowCeilingSelectors:q.cutoffSelection.selectorsEvaluated,rowCeilingDisabled:q.cutoffSelection.disabled};
}
export function winnerStable(r) {
  return Object.fromEntries(["scope","contract","complete","completionScope","queryKind","suffixBound","requestedWindow","arrivalDeadline",
    "winners","validationMode","lookupMode","traversalMode","witnessComparison","frontierStorage","pointerBytes","frontiers","counters","selection","lazy"].map(k=>[k,r[k]]));
}
export function checkWinnerResult(r,p,q,{goal,validation,options}) {
  if(r.scope!=="deadline-winner-session-wasm-experiment"||r.contract!=="lexicographic-filter-winners-v1-no-arrival-floor"
      ||r.complete!==true||r.completionScope!==q.completionScope||r.queryKind!==goal||r.suffixBound!=="row-prefix"
      ||!same(r.requestedWindow,[options.windowStart,options.windowEnd])||r.arrivalDeadline!==options.arrivalDeadline
      ||r.validationMode!==validation||r.lookupMode!==options.lookup||r.traversalMode!==options.traversal
      ||r.witnessComparison!==options.witnessComparison||r.frontierStorage!==options.frontierStorage
      ||!same(r.winners,q.winners)||!same(r.selection,nativeSelection(q)))throw Error("winner scope/canonical/selection mismatch");
  if(p.eventCount!==q.events||!same(p.catalogueKey,q.catalogueKey)||p.catalogueMode!=="fresh"||p.catalogueReused!==false
      ||p.lookupMode!==options.lookup||p.traversalMode!==options.traversal||p.witnessComparison!==options.witnessComparison
      ||p.frontierStorage!==options.frontierStorage||p.staticBound!==false||p.walkingBound!==false||p.forwardSeeds!==false)
    throw Error("winner prepared identity/mode mismatch");
  const byteKeys=["arenaBytes","incomingIndexBytes"],c=r.counters;
  if(!same(Object.keys(c).sort(),Object.keys(q.counters).sort())||Object.entries(c).some(([k,v])=>k==="prefixEnabled"?v!==q.counters[k]:!count(v)||!byteKeys.includes(k)&&v!==q.counters[k])
      ||c.segments>options.maxSegments||c.maxFrontierWidth>options.maxFrontierWidth||c.stopWork>options.maxStopScans
      ||c.lookupWork>options.maxLookupWork||c.stopWork!==c.seedEventChecks+c.stopEventsScanned+c.prefixEventScans+c.prefixWalkingRelaxations)
    throw Error("winner native work mismatch");
  checkFrontierStats(r.frontiers,{storage:options.frontierStorage,pointerBytes:r.pointerBytes,eventCount:p.eventCount,segmentsEnqueued:c.segments},
    {...q.frontiers,eventCount:q.events});
  const d=r.lazy;
  if(!d||Object.entries(d).some(([k,v])=>k==="stopIndexed"?v!==true:!count(v))
      ||d.work!==c.lookupWork||d.eventProbes!==c.eventProbes||d.pairChecks!==c.pairChecks||d.instanceProbes!==c.instanceProbes
      ||d.sourceBoundCacheProbes!==d.sourceBoundCacheHits+d.sourceBoundCacheMisses
      ||d.sourceBoundCacheBytes<d.sourceBoundCacheRows*16||d.sourceBoundCacheBytes>d.sourceBoundCacheRows*32
      ||d.work!==["eventProbes","pairChecks","instanceProbes","walkingIndexEdges","ruleCandidateEdges",
        "sourceBoundCacheRows","sourceBoundCacheProbes","sourceBoundCacheMisses"].reduce((n,k)=>n+d[k],0))throw Error("winner lazy accounting mismatch");
  if([r.prepareMs,r.searchMs,r.coreMs].some(n=>!finite(n))||r.prepareMs+r.searchMs>r.coreMs+.001)
    throw Error("winner phase timing mismatch");
}

function boundaries(probe,input,options) {
  const q={...input.tuples[0],maxRounds:input.maxRounds},run=()=>probe.run_winners(input.goal,"row-prefix");
  const rejects=(label,fn,re)=>{let caught=false;try{fn();}catch(e){if(!re.test(String(e)))throw Error(`unexpected rejection for ${label}: ${e}`);caught=true;}if(!caught)throw Error(`missing rejection: ${label}`);};
  rejects("unprepared winner",run,/not prepared/);
  probe.prepare(q,options);
  for(const goal of ["profile","top3","latest","",null,1])rejects("goal",()=>probe.run_winners(goal,"row-prefix"),/goal|length|charCodeAt|memory|slice|expected|undefined|null/i);
  for(const suffix of ["on","row-ceiling","before-pairs","",null,1])rejects("suffix",()=>probe.run_winners("portfolio",suffix),/suffix|length|charCodeAt|memory|slice|expected|undefined|null/i);
  const want=input.boundaryWinners;
  const all=probe.run_winners("portfolio","row-prefix");
  if(!same(all.winners,want)||all.completionScope!=="fixed-selectors-only")throw Error("boundary portfolio parity");
  for(const goal of WINNER_GOALS){const r=probe.run_winners(goal,"row-prefix");
    if(!same(r.winners,{[goal]:want[goal]})||r.completionScope!=="single-selector-only")throw Error("boundary single selector parity");
  }
  // Off is explicit and exact too; it need not have the same search work.
  if(!same(probe.run_winners("portfolio","off").winners,want))throw Error("unpruned winner parity");
  const mutableQ=structuredClone(q),mutableO=structuredClone(options);
  probe.prepare(mutableQ,mutableO);const before=winnerStable(run());
  mutableQ.entryStops.length=0;mutableQ.maxRounds=0;mutableO.maxLookupWork=1;mutableO.objective="r3";mutableO.validation="wrong";
  if(!same(before,winnerStable(run())))throw Error("caller mutation changed owned request");
  probe.prepare({...q,entryStops:[]},{...options,catalogue:"reuse"});
  const empty=probe.run_winners("portfolio","row-prefix");
  if(!same(empty.winners,Object.fromEntries(WINNER_GOALS.map(k=>[k,null]))))throw Error("stale winner after changed query");
  for(const patch of [{unknown:1},{validation:"wrong"},{catalogue:"wrong"},{frontierStorage:"wrong"},
    {windowStart:Number.MAX_SAFE_INTEGER+1},{maxSegments:0},{maxLookupWork:1.5},{windowEnd:options.windowStart}]){
    probe.prepare(q,options);rejects("invalid prepare",()=>probe.prepare(q,{...options,...patch}),/options|preparation|invalid deadline|safe integers/);
    rejects("stale failed preparation",run,/not prepared/);
  }
  probe.prepare(q,options);rejects("invalid query",()=>probe.prepare({...q,date:"bad"},options),/date/);rejects("stale query",run,/not prepared/);
  // Profile preparation remains legal; core winner eligibility must not weaken.
  for(const patch of [{objective:"r3"},{forwardSeeds:true}]){
    probe.prepare(q,{...options,...patch});rejects("ineligible winners",run,/InvalidRequest/);
  }
  for(const [cap,error]of [["maxLookupWork",/WorkExhausted/],["maxStopScans",/StopScansExhausted/],["maxSegments",/SegmentsExhausted/]]){
    probe.prepare(q,{...options,[cap]:1});rejects("cap with no partial",run,error);
  }
  const {validation:ignored,...defaults}=options;void ignored;
  probe.prepare(q,defaults);if(probe.run_winners("latest-departure","row-prefix").validationMode!=="checked")throw Error("winner default is not checked");
  probe.clear();rejects("cleared winner",run,/not prepared/);rejects("cleared profile",()=>probe.run(),/not prepared/);
  return true;
}

export async function runWinnerCases(input,hooks={}) {
  if(!["latest-departure","portfolio"].includes(input.goal)||!["checked","session"].includes(input.validation)
      ||!Number.isSafeInteger(input.iterations)||input.iterations<1||input.iterations>1000
      ||!Number.isSafeInteger(input.warmup)||input.warmup<0||input.warmup>1000
      ||input.tuples?.length!==10||input.expected?.length!==10)throw Error("invalid winner workload");
  const options={...input.options,validation:input.validation,catalogue:"fresh"};
  const fetchBytes=hooks.fetchBytes??(async url=>{const r=await fetch(url);if(!r.ok)throw Error(`input HTTP ${r.status}`);return new Uint8Array(await r.arrayBuffer());});
  const began=performance.now(),pkg=await(hooks.loadModule??(url=>import(url)))("/pt_wasm.js");
  const [wasm,ptb,ptft]=await Promise.all([fetchBytes("/pt_wasm_bg.wasm"),fetchBytes("/bundle.ptb"),fetchBytes("/transfers.bin")]);
  const exports=await pkg.default({module_or_path:wasm}),moduleLoadMs=performance.now()-began;
  const initialLinearBytes=exports.memory.buffer.byteLength,at=performance.now(),probe=new pkg.TemporalDeadlineProbe(ptb,ptft,input.patternMode);
  const constructorMs=performance.now()-at,afterConstructorLinearBytes=exports.memory.buffer.byteLength,rows=[];
  let boundaryChecksPassed=false;
  try {
    if(input.verifyBoundary)boundaryChecksPassed=boundaries(probe,input,options);
    for(const [i,q]of input.tuples.entries()){
      const beforePreparationLinearBytes=exports.memory.buffer.byteLength,began=performance.now();let prepared;
      try{prepared=probe.prepare({...q,maxRounds:input.maxRounds},options);}catch(e){rows.push({tupleIndex:i,status:"failed",stage:"prepare",error:String(e)});continue;}
      const preparationMs=performance.now()-began;
      const execute=()=>{
        const began=performance.now(),r=probe.run_winners(input.goal,"row-prefix"),ms=performance.now()-began;
        if(input.expected[i].status!=="completed")throw Error("unexpected completion of capped native query");
        checkWinnerResult(r,prepared,input.expected[i],{goal:input.goal,validation:input.validation,options});
        return{r,ms};
      };
      try{
        const first=execute(),firstCallMs=first.ms,stable=winnerStable(first.r);
        for(let n=0;n<input.warmup;n++)if(!same(winnerStable(execute().r),stable))throw Error("winner warmup drift");
        const beforeTimedLinearBytes=exports.memory.buffer.byteLength,samplesMs=[],prepareSamplesMs=[],searchSamplesMs=[],coreSamplesMs=[];
        for(let n=0;n<input.iterations;n++){
          const{r,ms}=execute();if(!same(winnerStable(r),stable))throw Error("winner repeat drift");
          samplesMs.push(ms);prepareSamplesMs.push(r.prepareMs);searchSamplesMs.push(r.searchMs);coreSamplesMs.push(r.coreMs);
        }
        rows.push({tupleIndex:i,status:"completed",parity:"full-native-canonical-winners-and-work",result:stable,eventIndex:prepared,
          preparationMs,firstCallMs,preparationPlusFirstCallMs:preparationMs+firstCallMs,beforePreparationLinearBytes,beforeTimedLinearBytes,
          afterTimedLinearBytes:exports.memory.buffer.byteLength,samplesMs,prepareSamplesMs,searchSamplesMs,coreSamplesMs,
          p50Ms:percentile(samplesMs,.5),p95Ms:percentile(samplesMs,.95),prepareP95Ms:percentile(prepareSamplesMs,.95),searchP95Ms:percentile(searchSamplesMs,.95)});
      }catch(e){rows.push({tupleIndex:i,status:"failed",stage:"query",error:String(e)});}
      probe.clear();
    }
  }finally{probe.free();}
  // An expected cap failure is a qualified empty failure, not a timed sample.
  const matched=rows.every((q,i)=>q.status===input.expected[i].status&&(q.status==="completed"
    ||q.stage==="query"&&q.error===`Error: deadline winner query: ${input.expected[i].error}`));
  return{status:matched?"matched":"failed",boundaryChecksPassed,queries:rows,moduleLoadMs,constructorMs,initialLinearBytes,afterConstructorLinearBytes,finalLinearBytes:exports.memory.buffer.byteLength};
}
