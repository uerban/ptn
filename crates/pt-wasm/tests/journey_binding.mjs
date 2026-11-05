// Fresh release-WASM journey contract, never latency qualification.
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const [pkgPath,out]=process.argv.slice(2);assert(pkgPath&&out);
const pkg=await import(pathToFileURL(resolve(pkgPath)).href),hash=b=>createHash("sha256").update(b).digest("hex");
const base="data/temporal-bench/vilnius-20261012",files={ptb:`${base}/staging/bundle.ptb`,ptft:`${base}/transfers/transfers.bin`,tuples:`${base}/frozen-corpus/query-tuples.json`};
const bytes=Object.fromEntries(await Promise.all(Object.entries(files).map(async([k,p])=>[k,await readFile(p)])));
const pins={ptb:"10e7e40bc458296ebb7cbb678acd9843b2d4969ce545574cb8ca8b11609712ea",ptft:"172a38dd2a1e3337c78f46d90c9dd49028260be09e19ae1a823992840ad43ece",tuples:"fbac281efea3e8a480c219a526b342219acb57fdd863c14898089caf5c9d6ba3"};
for(const k of Object.keys(files))assert.equal(hash(bytes[k]),pins[k]);
const tuples=JSON.parse(bytes.tuples).tuples,records=[],selectors=["latest-departure","fastest","least-walking","fewest-transfers"];
const fixture=await readFile("packages/shared/src/ptb/__fixtures__/tiny-v2.ptb");
for(const mode of["off","unbounded","covering-merge"]){
 for(const start of[3600,43200])records.push({name:`v2-${start}`,mode,ptb:fixture,ptft:new Uint8Array(),q:{date:"20260507",departureSecs:start,maxRounds:4,entryStops:[{stopId:"S3",walkSecs:20}],exitStops:[{stopId:"S4",walkSecs:40}]},window:[start,start+14401,start+14400]});
 for(const i of[0,5])records.push({name:`city-${i}`,mode,ptb:bytes.ptb,ptft:bytes.ptft,q:{...tuples[i],maxRounds:4},window:[21600,36001,36000]});
}
const movementKeys=["journeyContract","journeys","journeyByPreference","projection","movementMs"];
const stable=r=>{const c=structuredClone(r);for(const k of["prepareMs","searchMs","coreMs","movementMs"])delete c[k];return c;};
const certificate=r=>{const c=stable(r);for(const k of movementKeys)delete c[k];return c;};
let calls=0,checks=0,freed=0,nonempty=0,boundariesDone=false;const rows=[];
const reject=(fn,re)=>{assert.throws(fn,re);checks++;};
function check(r,o,goal){
 assert.equal(r.complete,true);assert.equal(r.journeyContract,"complete-selected-movement-v1");
 assert.equal(r.queryKind,goal);assert.equal(r.completionScope,goal==="portfolio"?"fixed-selectors-only":"single-selector-only");
 const requested=goal==="portfolio"?selectors:[goal];
 assert.deepEqual(Object.keys(r.journeyByPreference).sort(),[...requested].sort());
 const d=r.projection,c=r.counters;
 assert.equal(d.aggregateStopWork,c.stopWork+d.stopWork);assert.equal(d.aggregateLookupWork,c.lookupWork+d.lookupWork);
 assert(d.aggregateStopWork<=o.maxStopScans&&d.aggregateLookupWork<=o.maxLookupWork);
 assert.equal(d.uniqueJourneys,r.journeys.length);assert(r.journeys.length<=requested.length);
 assert.equal(d.metadataRecords,2*r.journeys.reduce((n,j)=>n+j.rides.length,0));
 assert.equal(d.metadataStopIds,r.journeys.reduce((n,j)=>n+3+j.rides.reduce((s,l)=>s+2+l.patternStopIds.length,0)+2*j.connections.length,0));
 const seen=new Set();
 for(const s of requested){const at=r.journeyByPreference[s];if(r.winners[s]===null){assert.equal(at,null);continue;}
  assert(Number.isSafeInteger(at)&&at>=0&&at<r.journeys.length);seen.add(at);assert.deepEqual(r.journeys[at].point,r.winners[s]);}
 assert.equal(seen.size,r.journeys.length);
 for(const j of r.journeys){nonempty++;const p=j.point;let walking=j.access.walkSecs,transfers=0;
  assert.equal(Object.keys(p).length,8);assert.equal(j.rides.length,p.witness.length);assert.equal(j.connections.length+1,j.rides.length);
  assert.equal(p.departureSecs+j.access.walkSecs,p.witness[0].boardSecs);
  assert.equal(j.access.stopId,j.rides[0].fromStopId);
  for(let i=0;i<j.rides.length;i++){
   const l=j.rides[i],w=p.witness[i];assert.deepEqual(l.witness,w);assert.equal(Object.keys(w).length,11);
   assert.equal(l.patternStopIds[w.boardPosition],l.fromStopId);assert.equal(l.patternStopIds[w.alightPosition],l.toStopId);
   for(const id of[l.routeId,l.tripId,l.fromStopId,l.toStopId,...l.patternStopIds])assert.equal(typeof id,"string");
   assert.equal(typeof l.mode,"string");assert.equal(l.approximate,w.frequencyInstance);
   if(i){const c=j.connections[i-1];assert.equal(c.fromStopId,j.rides[i-1].toStopId);assert.equal(c.toStopId,l.fromStopId);
    assert.equal(c.arrivalSecs,j.rides[i-1].witness.alightSecs);assert.equal(c.boardingSecs,w.boardSecs);
    assert(c.walkSecs<=c.minimumElapsedSecs&&c.arrivalSecs+c.minimumElapsedSecs<=c.boardingSecs);
    assert(["same-stop","footpath","synthetic","linked","in-seat","derived"].includes(c.kind));
    assert.equal(c.spendsTransfer,!["in-seat","derived"].includes(c.kind));assert.equal(c.spendsTransfer,!w.inSeat);
    walking+=c.walkSecs;transfers+=Number(c.spendsTransfer);
   }
  }
  const e=j.egress,last=j.rides.at(-1);assert.equal(e.fromStopId,last.toStopId);
  walking+=e.physicalWalkSecs+e.callerWalkSecs;
  assert.equal(last.witness.alightSecs+e.physicalWalkSecs+e.callerWalkSecs,p.arrivalSecs);
  assert.equal(walking,p.totalWalkSecs);assert.equal(transfers,p.actualTransfers);
 }
 checks++;return r;
}
function run(p,o,goal="portfolio",suffix="row-prefix"){
 const before=p.run_winners(goal,suffix);calls++;
 const r=p.run_winner_journeys(goal,suffix);calls++;
 assert.deepEqual(certificate(r),certificate(before));check(r,o,goal);return stable(r);
}
function boundaries(p,r,o){
 const prep=()=>p.prepare(r.q,o),go=()=>run(p,o);
 prep();const first=go();
 for(const patch of[{prefixSetup:"bad"},{unknownMovementToken:{}},{maxStopScans:0},{validation:"checked"}]){
  prep();reject(()=>p.prepare(r.q,{...o,...patch}),/unknown deadline|deadline options|invalid deadline|prefix experiment/);
  reject(()=>p.run_winner_journeys("portfolio","row-prefix"),/not prepared/);
 }
 prep();reject(()=>p.prepare({...r.q,date:"bad"},o),/date/);reject(()=>p.run_winner_journeys("portfolio","row-prefix"),/not prepared/);
 prep();for(const args of[["latest","row-prefix"],["portfolio","bad"]])reject(()=>p.run_winner_journeys(...args),/invalid winner/);
 const q=structuredClone(r.q),opts=structuredClone(o);p.prepare(q,opts);q.entryStops=[];opts.maxStopScans=1;assert.deepEqual(go(),first);checks++;
 for(const patch of[{entryStops:[]},{maxRounds:0},{excludedModes:[0,1,2,3,4,5,6,7,11,12]}]){p.prepare({...r.q,...patch},o);const empty=go();assert.equal(empty.journeys.length,0);assert(Object.values(empty.winners).every(w=>w===null));}
 for(const [cap,counter,error]of[["maxLookupWork","lookupWork",/WorkExhausted/],["maxStopScans","stopWork",/StopScansExhausted/]]){
  prep();const baseline=p.run_winners("portfolio","row-prefix");calls++;
  const exact={...o,[cap]:Math.max(1,baseline.counters[counter])};p.prepare(r.q,exact);
  assert.deepEqual(certificate(p.run_winners("portfolio","row-prefix")),certificate(baseline));calls++;
  reject(()=>p.run_winner_journeys("portfolio","row-prefix"),error);reject(()=>p.run_winner_journeys("portfolio","row-prefix"),error);
  prep();assert.deepEqual(go(),first);
 }
 prep();const mutated=go();mutated.journeys.length=0;assert.deepEqual(go(),first);checks++;
 p.clear();reject(()=>p.run_winner_journeys("portfolio","row-prefix"),/not prepared/);prep();assert.deepEqual(go(),first);
}
for(const r of records){
 const p=pkg.TemporalDeadlineProbe.withImmutableBinding(r.ptb,r.ptft,r.mode),results=[];let failed;
 try{
  reject(()=>p.run_winner_journeys("portfolio","row-prefix"),/not prepared/);
  for(const dateMode of["materialized","materialized-date-memo"])for(const[certificate,setup,validation]of[["duration","rebuild","checked"],["duration","rebuild","session"],["timetable","rebuild","checked"],["timetable","prepared","session"]]){
   const[windowStart,windowEnd,arrivalDeadline]=r.window,o={windowStart,windowEnd,arrivalDeadline,objective:"m4",validation,catalogue:"fresh",lookup:"lazy-cached",traversal:"arrival-first",witnessComparison:dateMode,frontierStorage:"event-indexed",prefixBound:true,pointBound:true,prefixCertificate:certificate,prefixSetup:setup,maxSegments:250000,maxFrontierWidth:64,maxStopScans:10000000,maxLookupWork:10000000};
   try{p.prepare(r.q,o);}catch(e){assert.equal(r.mode,"off");assert(r.name.startsWith("city-"));assert.match(String(e),/nonmonotone vehicle events/);failed=String(e);reject(()=>p.run_winner_journeys("portfolio","row-prefix"),/not prepared/);continue;}
   assert(!failed);const all=run(p,o);assert.deepEqual(run(p,o),all);
   for(const goal of selectors){const one=run(p,o,goal);assert.deepEqual(one.winners,{[goal]:all.winners[goal]});}
   assert.deepEqual(run(p,o,"portfolio","off").winners,all.winners);
   results.push({dateMode,certificate,setup,validation,result:all});
   if(!boundariesDone&&r.name==="city-0"&&r.mode==="covering-merge"&&setup==="prepared"){boundaries(p,r,o);boundariesDone=true;}
  }
 }finally{p.free();freed++;}
 rows.push({name:r.name,mode:r.mode,...(failed?{status:"failed",stage:"prepare",error:failed}:{status:"completed",results})});
}
assert(boundariesDone&&nonempty>0);assert.equal(freed,records.length);
for(const mode of["off","unbounded","covering-merge"]){assert(rows.some(r=>r.mode===mode&&r.status==="completed"));console.log(`temporal-journey-binding: ${rows.filter(r=>r.mode===mode).length} records compared (${mode}), 0 mismatch`);}
const report={scope:"release-wasm-journey-api-corpus",records:rows.length,completed:rows.filter(r=>r.status==="completed").length,failed:rows.filter(r=>r.status==="failed").length,calls,checks,freed,nonempty,pins,fixtureSha256:hash(fixture),glueSha256:hash(await readFile(pkgPath)),wasmSha256:hash(await readFile(resolve(pkgPath,"..","pt_wasm_bg.wasm"))),rows,latencyQualified:false,deviceOwned:false,campaignComplete:false};
await writeFile(out,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify({records:report.records,completed:report.completed,failed:report.failed,calls,checks,freed}));
