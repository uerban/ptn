// Actual release-WASM factory/lifetime proof. Timing is deliberately unqualified.
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {constructOwner} from "./owner_binding_worker.mjs";
import {checkOwnerBindingInfo} from "./owner_binding_kernel.mjs";
const [pkgPath,out]=process.argv.slice(2);assert(pkgPath&&out);
const pkg=await import(pathToFileURL(resolve(pkgPath)).href),hash=b=>createHash("sha256").update(b).digest("hex");
const base="data/temporal-bench/vilnius-20261012",files={ptb:`${base}/staging/bundle.ptb`,ptft:`${base}/transfers/transfers.bin`,tuples:`${base}/frozen-corpus/query-tuples.json`};
const bytes=Object.fromEntries(await Promise.all(Object.entries(files).map(async([k,p])=>[k,await readFile(p)])));
const pins={ptb:"10e7e40bc458296ebb7cbb678acd9843b2d4969ce545574cb8ca8b11609712ea",ptft:"172a38dd2a1e3337c78f46d90c9dd49028260be09e19ae1a823992840ad43ece",tuples:"fbac281efea3e8a480c219a526b342219acb57fdd863c14898089caf5c9d6ba3"};
for(const k of Object.keys(files))assert.equal(hash(bytes[k]),pins[k]);
const tuples=JSON.parse(bytes.tuples).tuples,records=[];
for(const mode of ["off","unbounded","covering-merge"]){
 for(const start of[3600,43200])records.push({name:`v2-${start}`,mode,ptb:await readFile("packages/shared/src/ptb/__fixtures__/tiny-v2.ptb"),ptft:new Uint8Array(),
  q:{date:"20260507",departureSecs:start,maxRounds:4,entryStops:[{stopId:"S3",walkSecs:0}],exitStops:[{stopId:"S4",walkSecs:0}]},window:[start,start+14401,start+14400]});
 for(const i of[0,5])records.push({name:`city-${i}`,mode,ptb:bytes.ptb,ptft:bytes.ptft,q:{...tuples[i],maxRounds:4},window:[21600,36001,36000]});
}
const stable=r=>{const c=structuredClone(r);for(const k of["prepareMs","searchMs","coreMs"])delete c[k];return c;};
let calls=0,checks=0,freed=0;const rows=[],footprints={};
const run=(p,goal="portfolio")=>{calls++;return stable(p.run_winners(goal,"row-prefix"));};
const reject=(fn,re)=>{assert.throws(fn,re);checks++;};
const get=(p,policy)=>{const info=p.owner_binding_info();checkOwnerBindingInfo(info,policy);checks++;footprints[policy]=info;return info;};
function boundaries(p,r,o,policy){
 const prep=()=>p.prepare(r.q,o),go=()=>run(p);
 prep();const first=go(),before=get(p,policy);
 for(const patch of[{ownerBinding:"retained"},{bindingInfo:{}},{prefixSetup:"bad"},{maxStopScans:0}]){
  prep();reject(()=>p.prepare(r.q,{...o,...patch}),/unknown deadline|deadline options|invalid deadline/);reject(go,/not prepared/);
 }
 prep();reject(()=>p.prepare({...r.q,date:"bad"},o),/date/);reject(go,/not prepared/);
 const q=structuredClone(r.q),opts=structuredClone(o);p.prepare(q,opts);q.entryStops=[];opts.maxStopScans=1;assert.deepEqual(go(),first);checks++;
 for(const patch of[{entryStops:[]},{maxRounds:0},{excludedModes:[0,1,2,3,4,5,6,7,11,12]}]){
  p.prepare({...r.q,...patch},o);const got=go();p.prepare({...r.q,...patch},{...o,prefixSetup:"rebuild",validation:"checked"});
  assert.deepEqual(go().winners,got.winners);checks++;
 }
 for(const [cap,error]of[["maxLookupWork",/WorkExhausted/],["maxStopScans",/StopScansExhausted/],["maxSegments",/SegmentsExhausted/]]){
  p.prepare(r.q,{...o,[cap]:1});reject(go,error);reject(go,error);prep();assert.deepEqual(go(),first);checks++;
 }
 p.clear();reject(go,/not prepared/);assert.deepEqual(get(p,policy),before);prep();assert.deepEqual(go(),first);checks++;
 p.prepare(r.q,{...o,prefixSetup:"rebuild",validation:"checked"});assert.deepEqual(go().winners,first.winners);checks++;
}
for(const r of records){
 const outputs={};
 for(const policy of["recompute","retained"]){
  // Both constructors must own copies, even after the JS input arrays change.
  const ptb=new Uint8Array(r.ptb),ptft=new Uint8Array(r.ptft),p=constructOwner(pkg,ptb,ptft,r.mode,policy);
  ptb.fill(0);ptft.fill(0);const before=get(p,policy),results=[];let failure;
  try{
   reject(()=>run(p),/not prepared/);
   for(const dateMode of["materialized","materialized-date-memo"])for(const [certificate,setup]of[["duration","rebuild"],["timetable","prepared"]]){
    const [windowStart,windowEnd,arrivalDeadline]=r.window,o={windowStart,windowEnd,arrivalDeadline,objective:"m4",validation:"session",catalogue:"fresh",lookup:"lazy-cached",traversal:"arrival-first",
     witnessComparison:dateMode,frontierStorage:"event-indexed",prefixBound:true,pointBound:true,prefixCertificate:certificate,prefixSetup:setup,
     maxSegments:250000,maxFrontierWidth:64,maxStopScans:10000000,maxLookupWork:10000000};
    let prepared;try{prepared=p.prepare(r.q,o);}catch(e){
     assert.equal(r.mode,"off");assert(r.name.startsWith("city-"));assert.match(String(e),/nonmonotone vehicle events/);
     if(failure)assert.equal(String(e),failure);failure=String(e);reject(()=>run(p),/not prepared/);continue;
    }
    assert(!failure);const result=run(p);assert.equal(result.complete,true);
    assert.deepEqual(run(p),result);
    for(const goal of["latest-departure","fastest","least-walking","fewest-transfers"])assert.deepEqual(run(p,goal).winners,{[goal]:result.winners[goal]});
    results.push({dateMode,certificate,setup,prepared,result});
    if(r.name==="city-0"&&r.mode==="covering-merge"&&dateMode==="materialized-date-memo"&&certificate==="timetable")boundaries(p,r,o,policy);
   }
   p.clear();assert.deepEqual(get(p,policy),before);reject(()=>run(p),/not prepared/);
  }finally{p.free();freed++;}
  outputs[policy]=failure?{status:"failed",stage:"prepare",error:failure}:{status:"completed",results};
 }
 assert.deepEqual(outputs.recompute,outputs.retained,`${r.name}/${r.mode}: policy changed canonical/work/config binding`);
 rows.push({name:r.name,mode:r.mode,...outputs.retained});
}
for(const mode of["off","unbounded","covering-merge"]){assert(rows.some(r=>r.mode===mode&&r.status==="completed"));console.log(`temporal-owner-binding: ${rows.filter(r=>r.mode===mode).length} records compared (${mode}), 0 mismatch`);}
assert.equal(freed,records.length*2);assert(checks>0&&calls>0);
const report={scope:"real-release-wasm-owner-binding-corpus",records:records.length,completed:rows.filter(r=>r.status==="completed").length,failed:rows.filter(r=>r.status==="failed").length,
 calls,checks,freed,footprints,pins,glueSha256:hash(await readFile(pkgPath)),wasmSha256:hash(await readFile(resolve(pkgPath,"..","pt_wasm_bg.wasm"))),rows,latencyQualified:false,deviceOwned:false,campaignComplete:false};
await writeFile(out,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({records:report.records,completed:report.completed,failed:report.failed,calls,checks,freed,latencyQualified:false}));
