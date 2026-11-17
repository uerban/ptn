import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,existsSync,writeFileSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {retainArtifact,retainRun} from "./baseline_store.mjs";
import {buildReviewBundle} from "./baseline_review.mjs";
import {exportReviewComparison} from "./baseline_review_compare.mjs";
import {createReviewComparison,validateReviewBundle} from "../../../tools/search-review/contract.mjs";
import {createReviewSession,appendReviewAction,reviewActionsFile} from "../../../tools/search-review/state.mjs";

function fixture() {
 const root=mkdtempSync(join(tmpdir(),"review-compare-"));
 const artifacts=Object.fromEntries(["ptb","queryTuples","glue","wasm"].map(key=>[key,retainArtifact(root,Buffer.from(key))]));
 const a={legs:[],alightSecs:10},b={legs:[],alightSecs:20};
 const capture={boundary:"stop-level engine",equivalence:"exact",truncated:false};
 const before={schemaVersion:1,completion:"success",scope:"stop-level compiled engine",classification:"partial capture",replayVerification:"unverified",missingDependencies:["fixture"],unsupported:["geometry"],artifacts,
  report:{runtime:{node:"test",v8:"test",platform:"test",arch:"test",release:"test"},patternMode:"covering-merge",objective:"plan",glueExecution:"snapshot-data-url-v1",input:{windowStart:null,windowEnd:null},
   tuples:[{query:{departureSecs:0},capture,candidates:[a,b,b]},{query:{departureSecs:1},capture,candidates:[]}]}};
 const after=structuredClone(before);after.artifacts.wasm=retainArtifact(root,Buffer.from("new-wasm"));
 after.report.tuples[0].candidates=[b,a,a];after.report.tuples[1].candidates=[a];after.report.tuples[1].capture.truncated=true;
 retainRun(root,"before",before);retainRun(root,"after",after);
 return {root,before,after};
}

test("comparison preserves source ordering, duplicate occurrences, empty changes and truncation",async()=>{
 const {root,before,after}=fixture();
 try {
  const dest=join(root,"comparison.json"),bundle=await exportReviewComparison(root,"before","after",dest);
  assert.equal(statSync(dest).mode&0o777,0o600);
  assert.equal(bundle.version,2);assert.equal(bundle.comparison.primarySource,"before");
  for(const [index,row] of bundle.cases.entries()) {
   assert.deepEqual(row.candidates.filter(c=>c.source.side==="before").map(c=>c.itinerary),before.report.tuples[index].candidates);
   assert.deepEqual(row.candidates.filter(c=>c.source.side==="after").map(c=>c.itinerary),after.report.tuples[index].candidates);
   assert.equal(new Set(row.candidates.map(c=>c.id)).size,row.candidates.length);
   assert.equal(row.comparisonStatus,"changed/unreviewed");
  }
  assert.equal(bundle.cases[1].capture.truncated,true);
  assert.deepEqual(await validateReviewBundle(bundle),bundle);
  const same=await exportReviewComparison(root,"before","before",join(root,"same.json"));
  assert.equal(same.cases[0].comparisonStatus,"unchanged");assert.equal(same.cases[0].candidates.length,6);
  await assert.rejects(exportReviewComparison(root,"before","after",dest),/EEXIST/);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("matched portable comparison rejects confounded inputs and unknown legacy execution metadata",async()=>{
 const {root}=fixture();
 try {
  const a=await buildReviewBundle(root,"before"),b=await buildReviewBundle(root,"after");
  // Re-signing changed portable source fixtures is deliberately not a source
  // authenticity check; contract validation still rejects incompatible metadata.
  const {fingerprint}=await import("../../../tools/search-review/contract.mjs");
  for(const mutate of [p=>{p.artifacts.ptb="c".repeat(64);},p=>{p.runtime.arch="other";},p=>{p.executionContract="file-url-v0";},p=>{delete p.executionContract;}]) {
   const bad=structuredClone(b);mutate(bad.provenance);
   const oldSnapshot=bad.provenance.snapshotId;
   bad.provenance.snapshotId=await fingerprint({artifacts:bad.provenance.artifacts,runtime:bad.provenance.runtime,settings:bad.provenance.settings});
   if(oldSnapshot!==bad.provenance.snapshotId) {
    for(const [index,row] of bad.cases.entries()) {
     row.id=await fingerprint({snapshotId:bad.provenance.snapshotId,query:row.query,index});
     for(const c of row.candidates)c.id=await fingerprint({caseId:row.id,itinerary:c.itinerary});
    }
   }
   const {bundleId,...content}=bad;bad.bundleId=await fingerprint(content);
   await assert.rejects(createReviewComparison(a,bad),/incomparable/);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("derived comparison edits reject; blind neutral actions bind both snapshots",async()=>{
 const {root}=fixture();
 try {
  const bundle=await exportReviewComparison(root,"before","after",join(root,"comparison.json"));
  for(const mutate of [b=>{b.cases[0].candidates[0].source.rank=2;},b=>{b.cases[0].comparisonStatus="preferred";},b=>{b.cases[0].candidates.reverse();}]) {
   const bad=structuredClone(bundle);mutate(bad);await assert.rejects(validateReviewBundle(bad),/derivation/);
  }
  let session=await createReviewSession(bundle,"reviewer","fixed");
  session=await appendReviewAction(bundle,session,{kind:"compare",caseId:bundle.cases[0].id,candidateIds:session.assignments[0].candidateIds.slice(0,2),choice:"equivalent",confidence:"medium",familiarity:"unknown",reasons:[],notes:""});
  assert.equal((await reviewActionsFile(bundle,[session])).sessions[0].actions[0].choice,"equivalent");
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("corrupt either retained source fails before comparison output",async()=>{
 const {root,after}=fixture();
 try {
  writeFileSync(join(root,"artifacts",after.artifacts.wasm),"corrupt");
  const dest=join(root,"comparison.json");
  await assert.rejects(exportReviewComparison(root,"before","after",dest),/integrity/);
  assert.equal(existsSync(dest),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("ordering changes stay unreviewed and query mismatches never create output",async()=>{
 const {root,before}=fixture();
 try {
  const reordered=structuredClone(before);reordered.report.tuples[0].candidates.reverse();
  retainRun(root,"reordered",reordered);
  const comparison=await exportReviewComparison(root,"before","reordered",join(root,"order.json"));
  assert.equal(comparison.cases[0].comparisonStatus,"changed/unreviewed");
  assert.equal(comparison.cases[1].comparisonStatus,"unchanged");
  const mismatched=structuredClone(before);mismatched.report.tuples[0].query.departureSecs=999;
  retainRun(root,"query-mismatch",mismatched);
  const dest=join(root,"mismatch.json");
  await assert.rejects(exportReviewComparison(root,"before","query-mismatch",dest),/incomparable query/);
  assert.equal(existsSync(dest),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});
