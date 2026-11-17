import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {retainArtifact,retainRun} from "./baseline_store.mjs";
import {exportReviewBundle} from "./baseline_review.mjs";
import {canonical,fingerprint,validateReviewBundle} from "../../../tools/search-review/contract.mjs";

function fixture() {
  const root=mkdtempSync(join(tmpdir(),"search-review-"));
  const artifacts=Object.fromEntries(["ptb","queryTuples","glue","wasm","sourceGTFS"].map(name=>[name,retainArtifact(root,Buffer.from(name))]));
  const first={legs:[{type:"transit",tripId:"<script>throw 'unsafe'</script>",departSecs:10,arriveSecs:20,boardStopIdx:1,alightStopIdx:3}],boardSecs:10,alightSecs:20,transfers:0};
  const second={...first,legs:[{...first.legs[0],tripId:"other",arriveSecs:30}],alightSecs:30};
  const capture={boundary:"stop-level engine",equivalence:"exact",truncated:false};
  const record={schemaVersion:1,completion:"success",scope:"stop-level compiled engine",classification:"partial capture",
    replayVerification:"unverified",missingDependencies:["external glue dependencies"],unsupported:["frontend geometry","real-time composition"],artifacts,
    report:{runtime:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,release:"fixture"},
      patternMode:"covering-merge",objective:"plan",input:{pkg:"/private/machine/path",windowStart:null,windowEnd:null},
      tuples:[{query:{departureSecs:0,date:"20261113"},candidates:[second,first,first],capture},{query:{departureSecs:1},candidates:[],capture:{...capture,truncated:true}}]}};
  retainRun(root,"fixture",record);
  return {root,record,destination:join(root,"review.json")};
}

test("exports ordered complete candidates, empty outcomes and honest provenance without raw artifacts or paths",async()=>{
 const {root,record,destination}=fixture();
 try {
  const bundle=await exportReviewBundle(root,"fixture",destination);
  assert.deepEqual(bundle.cases[0].candidates.map(candidate=>candidate.itinerary),record.report.tuples[0].candidates);
  assert.deepEqual(bundle.cases[1].candidates,[]);
  assert.equal(bundle.cases[1].capture.truncated,true);
  assert.equal(bundle.provenance.classification,"partial capture");
  assert.equal(bundle.provenance.replayVerification,"unverified");
  assert.deepEqual(bundle.provenance.unsupported,record.unsupported);
  assert.equal(readFileSync(destination,"utf8").includes("/private/machine/path"),false);
  assert.equal(bundle.cases[0].candidates[1].itinerary.legs[0].tripId,"<script>throw 'unsafe'</script>");
  assert.deepEqual(await validateReviewBundle(JSON.parse(readFileSync(destination))),bundle);
  const again=await exportReviewBundle(root,"fixture",join(root,"again.json"));
  assert.equal(again.bundleId,bundle.bundleId);
  await assert.rejects(exportReviewBundle(root,"fixture",destination),/EEXIST/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("rejects corrupt retained provenance before creating a portable bundle",async()=>{
 const {root,record,destination}=fixture();
 try {
  writeFileSync(join(root,"artifacts",record.artifacts.sourceGTFS),"corrupt");
  await assert.rejects(exportReviewBundle(root,"fixture",destination),/integrity/);
  assert.equal(existsSync(destination),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("candidate, query and snapshot changes cannot silently retain review identities",async()=>{
 const {root,destination}=fixture();
 try {
  const bundle=await exportReviewBundle(root,"fixture",destination);
  for (const mutate of [
    b=>{b.cases[0].candidates[0].itinerary.legs[0].arriveSecs++;},
    b=>{b.cases[0].query.departureSecs++;},
    b=>{b.provenance.artifacts.wasm="c".repeat(64);},
    b=>{b.cases[0].candidates.reverse();},
    b=>{b.provenance.unsupported=[];},
  ]) {
   const changed=structuredClone(bundle);mutate(changed);
   await assert.rejects(validateReviewBundle(changed),/identity mismatch/);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("rejects unsupported bundle versions and missing capture declarations",async()=>{
 const {root,destination}=fixture();
 try {
  const bundle=await exportReviewBundle(root,"fixture",destination);
  for (const mutate of [b=>{b.version=2;},b=>{delete b.cases[0].capture;},b=>{b.provenance.classification="verified";}]) {
   const changed=structuredClone(bundle);mutate(changed);
   await assert.rejects(validateReviewBundle(changed),/Invalid review bundle/);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("normalization ignores property order only, retaining all finite candidate fields",async()=>{
 assert.equal(await fingerprint({b:2,a:1}),await fingerprint({a:1,b:2}));
 assert.notEqual(await fingerprint([1,2]),await fingerprint([2,1]));
 assert.notEqual(await fingerprint({a:1}),await fingerprint({a:1,unknown:2}));
 for(const value of [NaN,Infinity,undefined,{a:undefined}]) assert.throws(()=>canonical(value),/finite JSON/);
});

test("optional compiled stop context is PTB-bound and exports only used stop labels",async()=>{
 const {root,record}=fixture();
 try {
  const context={format:"ptn-search-review-stop-context",version:1,derivation:"pt-core-reader-e7-name-v1",ptbSha256:record.artifacts.ptb,
   stops:[{stopId:"S1",name:"<img src=x onerror=alert(1)>",latE7:540000000,lonE7:250000000},
    {stopId:"S2",name:"Station",latE7:540000001,lonE7:250000001},
    {stopId:"unused",name:"Unneeded location",latE7:0,lonE7:0}]};
  for(const tuple of record.report.tuples) {
   tuple.query.entryStops=[{stopId:"S1",walkSecs:0}];tuple.query.exitStops=[{stopId:"S2",walkSecs:0}];
   for(const itinerary of tuple.candidates) for(const leg of itinerary.legs) {leg.fromStopId="S1";leg.toStopId="S2";}
  }
  record.artifacts.reviewStopContext=retainArtifact(root,Buffer.from(JSON.stringify(context)));
  retainRun(root,"named",record);
  const bundle=await exportReviewBundle(root,"named",join(root,"named.json"));
  assert.deepEqual(bundle.stopContext.stops,context.stops.slice(0,2));
  assert.equal(JSON.stringify(bundle).includes("Unneeded location"),false);
  assert.equal((await validateReviewBundle(bundle)).stopContext.stops[0].name,context.stops[0].name);
  const changed=structuredClone(bundle);changed.stopContext.stops[0].name="Changed";
  await assert.rejects(validateReviewBundle(changed),/identity mismatch/);
  for(const [index,mutate] of [c=>{c.ptbSha256="c".repeat(64);},c=>{c.stops.push(c.stops[0]);},c=>{c.stops[0].latE7=900000001;}].entries()) {
   const bad=structuredClone(context);mutate(bad);
   record.artifacts.reviewStopContext=retainArtifact(root,Buffer.from(JSON.stringify(bad)));
   const name=`bad-context-${index}`;
   retainRun(root,name,record);
   const destination=join(root,`${name}.json`);
   await assert.rejects(exportReviewBundle(root,name,destination),/stop context/);
   assert.equal(existsSync(destination),false);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
