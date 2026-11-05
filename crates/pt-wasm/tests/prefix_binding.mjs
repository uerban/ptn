// Run against a newly built isolated nodejs package, never a production package.
// No timings from this correctness corpus qualify latency.
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const [pkgPath,out,cityPtb,cityPtft,cityTuples]=process.argv.slice(2);
assert(pkgPath&&out&&cityPtb&&cityPtft&&cityTuples,"usage: node prefix_binding.mjs <isolated-pkg/pt_wasm.js> <new-report.json> <frozen-city.ptb> <frozen-ptft> <frozen-tuples.json>");
const pkg=await import(pathToFileURL(resolve(pkgPath)).href);
const selectors=["latest-departure","fastest","least-walking","fewest-transfers"];
const dates=["materialized","materialized-date-memo"];
const variants=[["duration","rebuild"],["duration","prepared"],["timetable","rebuild"],["timetable","prepared"]];
const hash=b=>createHash("sha256").update(b).digest("hex");
const goldenBytes=await readFile("crates/pt-core/tests/golden/raptor-plan.golden.tsv");
const records=goldenBytes.toString().split("\n").filter(l=>l&&!l.startsWith("#")).map(l=>{
  const [name,mode,ptb,ptft,query]=l.split("\t");return{name,mode,ptb,ptft,query:JSON.parse(query)};
});
assert(records.length>0);
const legacyRecords=records.length;
// Legacy production goldens are retained as typed-rejection coverage. Add the
// committed v2 frequency/overnight fixture and a fixed two-tuple city bridge
// cohort to exercise the enabled certificate, not only its linked-trip guard.
const cityBytes=await readFile(cityPtb),cityWalks=await readFile(cityPtft),tupleBytes=await readFile(cityTuples);
assert.equal(hash(cityBytes),"10e7e40bc458296ebb7cbb678acd9843b2d4969ce545574cb8ca8b11609712ea");
assert.equal(hash(cityWalks),"172a38dd2a1e3337c78f46d90c9dd49028260be09e19ae1a823992840ad43ece");
assert.equal(hash(tupleBytes),"fbac281efea3e8a480c219a526b342219acb57fdd863c14898089caf5c9d6ba3");
const city=JSON.parse(tupleBytes).tuples;
for(const mode of["off","unbounded","covering-merge"]){
  for(const start of[43200,3600])records.push({name:`committed-v2-${start}`,mode,ptb:"packages/shared/src/ptb/__fixtures__/tiny-v2.ptb",ptft:"",
    query:{date:20260507,departureSecs:start,maxRounds:4,entryStops:[{stopId:"S3",walkSecs:0}],exitStops:[{stopId:"S4",walkSecs:0}]}});
  for(const i of[0,5])records.push({name:`frozen-city-${i}`,mode,ptb:cityPtb,ptft:cityPtft,window:[21600,36001,36000],query:{...city[i],maxRounds:4}});
}
const stable=r=>{const c=structuredClone(r);for(const k of["prepareMs","searchMs","coreMs"])delete c[k];return c;};
const comparable=r=>{const c=stable(r);delete c.prefixExperiment;return c;};
const sameSetup=(a,b)=>{
  assert.deepEqual(comparable(a),comparable(b));
  if(a.prefixExperiment&&b.prefixExperiment){const x=structuredClone(a.prefixExperiment),y=structuredClone(b.prefixExperiment);delete x.setup;delete y.setup;assert.deepEqual(x,y);}
};
let calls=0,boundaryChecks=0,timetableEnabledCalls=0;const rows=[],modeCounts={},completedModeCounts={},inputHashes={[cityTuples]:hash(tupleBytes)};
function check(r,o,certificate,setup){
  calls++;assert.equal(r.complete,true);assert.equal(r.witnessDateMemoStackBytes,64);
  const c=r.counters,p=r.prefixExperiment,t=p?.timetable;
  assert(c.lookupWork<=o.maxLookupWork&&c.stopWork<=o.maxStopScans&&c.segments<=o.maxSegments&&c.maxFrontierWidth<=o.maxFrontierWidth);
  assert.equal(c.stopWork,c.seedEventChecks+c.stopEventsScanned+c.prefixEventScans+c.prefixWalkingRelaxations+(t?.work??0));
  if(certificate==="duration"&&setup==="rebuild")assert(!Object.hasOwn(r,"prefixExperiment"));
  else{
    assert.equal(p.certificate,certificate);assert.equal(p.setup,setup);assert.equal(p.enabled,c.prefixEnabled);
    assert.equal(t.work,t.eventScans+t.walkingProposals+t.profileChecks);
    assert.equal(p.nominalStopWork,c.prefixEventScans+c.prefixWalkingRelaxations+t.work);
    assert(p.indexBytes>=t.indexBytes);if(certificate==="duration")assert.equal(t.enabled,false);
    if(t.enabled)timetableEnabledCalls++;
  }
  return r;
}
function boundaries(probe,q,o){
  const advanced={...o,prefixCertificate:"timetable",prefixSetup:"prepared"};
  const prepare=()=>probe.prepare(q,advanced),run=()=>probe.run_winners("portfolio","row-prefix");
  const reject=(fn,re)=>{assert.throws(fn,re);boundaryChecks++;};
  prepare();const first=stable(run());
  reject(()=>probe.run(),/requires run_winners/);
  for(const patch of[{prefixCertificate:"bad"},{prefixSetup:"bad"},{prefixSetupp:"prepared"},
    {objective:"r3"},{catalogue:"reuse"},{validation:"checked"},{prefixBound:false},{pointBound:false},
    {staticBound:true},{walkingBound:true},{forwardSeeds:true},{maxStopScans:0}]){
    prepare();reject(()=>probe.prepare(q,{...advanced,...patch}),/options|prefix experiment|invalid deadline/);
    reject(run,/not prepared/);reject(()=>probe.run(),/not prepared/);
  }
  prepare();reject(()=>probe.prepare({...q,date:"bad"},advanced),/date/);reject(run,/not prepared/);
  const mutableQ=structuredClone(q),mutableO=structuredClone(advanced);
  probe.prepare(mutableQ,mutableO);mutableQ.entryStops=[];mutableO.maxStopScans=1;
  assert.deepEqual(stable(run()),first);boundaryChecks++;
  for(const patch of[{entryStops:[]},{maxRounds:0},{excludedModes:[0,1,2,3,4,5,6,7,11,12]}]){
    probe.prepare({...q,...patch},advanced);const got=run();
    probe.prepare({...q,...patch},{...advanced,prefixSetup:"rebuild"});sameSetup(got,run());boundaryChecks++;
  }
  probe.prepare({...q,entryStops:[]},advanced);assert(Object.values(run().winners).every(x=>x===null));boundaryChecks++;
  for(const [cap,error]of[["maxLookupWork",/WorkExhausted/],["maxStopScans",/StopScansExhausted/],["maxSegments",/SegmentsExhausted/]]){
    const failures=[];
    for(const setup of["rebuild","prepared"]){
      probe.prepare(q,{...advanced,prefixSetup:setup,[cap]:1});let caught;
      try{run();}catch(e){caught=String(e);}assert(caught&&error.test(caught),`${cap}: ${caught}`);
      assert.throws(run,error);failures.push(caught);boundaryChecks+=2;
    }
    assert.equal(failures[0],failures[1]);
    prepare();assert.deepEqual(stable(run()),first);boundaryChecks++;
  }
  prepare();probe.clear();reject(run,/not prepared/);reject(()=>probe.run(),/not prepared/);
  probe.prepare(q,{...advanced,prefixSetup:"rebuild",validation:"checked"});assert.deepEqual(run().winners,first.winners);boundaryChecks++;
}
let boundariesDone=false;
for(const record of records){
  const ptb=await readFile(record.ptb),ptft=record.ptft?await readFile(record.ptft):new Uint8Array();
  inputHashes[record.ptb]=hash(ptb);if(record.ptft)inputHashes[record.ptft]=hash(ptft);
  const q={...record.query,date:String(record.query.date)};
  if(q.maxRounds===null)delete q.maxRounds;
  if(q.excludedRouteTypes!==undefined)q.excludedModes=q.excludedRouteTypes;delete q.excludedRouteTypes;
  const probe=new pkg.TemporalDeadlineProbe(ptb,ptft,record.mode);
  try{
    for(const date of dates){
      const o={windowStart:q.departureSecs,windowEnd:q.departureSecs+14401,arrivalDeadline:q.departureSecs+14400,
        objective:"m4",validation:"session",catalogue:"fresh",lookup:"lazy-cached",traversal:"arrival-first",
        witnessComparison:date,frontierStorage:"event-indexed",prefixBound:true,pointBound:true,
        maxSegments:250000,maxFrontierWidth:64,maxStopScans:10000000,maxLookupWork:10000000};
      if(record.window)[o.windowStart,o.windowEnd,o.arrivalDeadline]=record.window;
      const results={};let baseline,failure;
      for(const[certificate,setup]of variants){
        const options=certificate==="duration"&&setup==="rebuild"?o:{...o,prefixCertificate:certificate,prefixSetup:setup};
        let prepared;
        try{prepared=probe.prepare(q,options);}catch(e){
          const error=String(e);
          const expected=record.name.startsWith("frozen-city-")&&record.mode==="off"
            ? /^Error: deadline preparation: Request\(InvalidRequest\("nonmonotone vehicle events"\)\)$/
            : /^Error: deadline preparation: Catalogue\(Engine\(UnsupportedVersion\)\)$/;
          assert.match(error,expected,`${record.name}/${record.mode}/${certificate}/${setup}`);
          assert(!baseline,"supported baseline cannot become an unsupported variant");
          if(failure)assert.equal(error,failure);else failure=error;
          assert.throws(()=>probe.run_winners("portfolio","row-prefix"),/not prepared/);boundaryChecks++;
          continue;
        }
        assert(!failure,"unsupported baseline cannot silently become a complete variant");
        if(certificate==="duration"&&setup==="rebuild")assert(!Object.hasOwn(prepared,"prefixExperiment"));
        else assert.deepEqual(prepared.prefixExperiment,{certificate,setup});
        const r=check(probe.run_winners("portfolio","row-prefix"),o,certificate,setup);
        if(!baseline)baseline=r;else assert.deepEqual(r.winners,baseline.winners,`${record.name}/${date}/${certificate}/${setup}`);
        sameSetup(r,check(probe.run_winners("portfolio","row-prefix"),o,certificate,setup));
        for(const goal of selectors){const single=check(probe.run_winners(goal,"row-prefix"),o,certificate,setup);
          assert.deepEqual(single.winners,{[goal]:r.winners[goal]});}
        results[`${certificate}/${setup}`]={prepared,result:stable(r)};
      }
      if(failure){rows.push({name:record.name,mode:record.mode,dateMode:date,status:"failed",stage:"prepare",error:failure,checkedVariants:variants.length});continue;}
      for(const c of["duration","timetable"])sameSetup(results[`${c}/rebuild`].result,results[`${c}/prepared`].result);
      rows.push({name:record.name,mode:record.mode,dateMode:date,status:"completed",results});
      completedModeCounts[record.mode]=(completedModeCounts[record.mode]??0)+1;
      if(!boundariesDone&&results["timetable/prepared"].result.prefixExperiment.timetable.enabled
          &&q.maxRounds!==0&&baseline.counters.segments>1&&baseline.counters.lookupWork>1&&baseline.counters.stopWork>1){boundaries(probe,q,o);boundariesDone=true;}
    }
  }finally{probe.free();}
  modeCounts[record.mode]=(modeCounts[record.mode]??0)+1;
}
assert(boundariesDone&&timetableEnabledCalls>0);for(const mode of["off","unbounded","covering-merge"]){assert(modeCounts[mode]>0&&completedModeCounts[mode]>0);console.log(`temporal-prefix-binding: ${modeCounts[mode]} records compared (${mode}), ${completedModeCounts[mode]} supported date-mode rows, 0 mismatch`);}
const report={scope:"real-release-wasm-prefix-binding-corpus",legacyRecords,records:records.length,rows:rows.length,calls,boundaryChecks,timetableEnabledCalls,modeCounts,completedModeCounts,
  sourceGoldenSha256:hash(goldenBytes),inputHashes,glueSha256:hash(await readFile(pkgPath)),
  wasmSha256:hash(await readFile(resolve(pkgPath,"..","pt_wasm_bg.wasm"))),rowsData:rows,latencyQualified:false,deviceOwned:false,campaignComplete:false};
await writeFile(out,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({records:report.records,rows:report.rows,calls,boundaryChecks,latencyQualified:false}));
