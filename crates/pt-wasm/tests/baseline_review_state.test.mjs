import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {retainArtifact,retainRun} from "./baseline_store.mjs";
import {exportReviewBundle} from "./baseline_review.mjs";
import {createReviewSession,appendReviewAction,effectiveReviewActions,reviewActionsFile,validateReviewActions,mergeReviewActions} from "../../../tools/search-review/state.mjs";

async function fixture() {
 const root=mkdtempSync(join(tmpdir(),"review-state-"));
 try {
  const artifacts=Object.fromEntries(["ptb","queryTuples","glue","wasm"].map(name=>[name,retainArtifact(root,Buffer.from(name))]));
  retainRun(root,"test",{schemaVersion:1,completion:"success",scope:"stop-level compiled engine",classification:"partial capture",
   replayVerification:"unverified",missingDependencies:["fixture"],unsupported:["geometry"],artifacts,
   report:{runtime:{node:"test",v8:"test",platform:"test",arch:"test",release:"test"},patternMode:"covering-merge",objective:"plan",
    input:{windowStart:null,windowEnd:null},tuples:[{query:{departureSecs:0},capture:{boundary:"stop-level engine",equivalence:"exact",truncated:false},
     candidates:[{legs:[],alightSecs:10},{legs:[],alightSecs:20},{legs:[],alightSecs:30}]}]}});
  return await exportReviewBundle(root,"test",join(root,"bundle.json"));
 } finally {rmSync(root,{recursive:true,force:true});}
}
const at="2026-11-17T00:00:00.000Z";
const judgment=(bundle,verdict="acceptable")=>({kind:"judge",caseId:bundle.cases[0].id,candidateId:bundle.cases[0].candidates[0].id,
 verdict,confidence:"medium",familiarity:"unknown",reasons:["long-wait"],notes:"<img src=x onerror=alert(1)>"});

test("blind assignments survive serialization and are seeded independently of source order",async()=>{
 const bundle=await fixture();
 const first=await createReviewSession(bundle,"reviewer","fixed-seed");
 assert.deepEqual(first,await createReviewSession(bundle,"reviewer","fixed-seed"));
 const orders=new Set();
 for(let n=0;n<10;n++) orders.add(JSON.stringify((await createReviewSession(bundle,"reviewer",String(n))).assignments));
 assert.ok(orders.size>1);
 const file=await reviewActionsFile(bundle,[first]);
 assert.deepEqual(await validateReviewActions(JSON.parse(JSON.stringify(file)),bundle),file);
 const changed=structuredClone(file);changed.sessions[0].assignments[0].candidateIds.reverse();
 await assert.rejects(validateReviewActions(changed,bundle),/assignment changed/);
});

test("committed judgments are immutable data and undo retains an explicit audit action",async()=>{
 const bundle=await fixture(),session=await createReviewSession(bundle,"reviewer","seed");
 const input=judgment(bundle);
 const saved=await appendReviewAction(bundle,session,input,at);
 input.notes="later draft";
 assert.equal(session.actions.length,0);
 assert.equal(saved.actions[0].notes,"<img src=x onerror=alert(1)>");
 assert.equal(effectiveReviewActions(saved).length,1);
 const undone=await appendReviewAction(bundle,saved,{kind:"undo",targetActionId:saved.actions[0].id},at);
 assert.equal(undone.actions.length,2);
 assert.deepEqual(effectiveReviewActions(undone),[]);
 await assert.rejects(appendReviewAction(bundle,undone,{kind:"undo",targetActionId:saved.actions[0].id},at),/already undone/);
 assert.equal((await reviewActionsFile(bundle,[undone])).sessions[0].actions.length,2);
});

test("pair choices bind the displayed blind order and preserve neutral answers",async()=>{
 const bundle=await fixture(),session=await createReviewSession(bundle,"reviewer","seed");
 const candidateIds=session.assignments[0].candidateIds.slice(0,2);
 for(const choice of ["A","B","equivalent","neither","cannot-judge"]) {
  const input={...judgment(bundle),kind:"compare",candidateIds,choice};delete input.candidateId;delete input.verdict;
  const next=await appendReviewAction(bundle,session,input,at);
  assert.equal(next.actions[0].choice,choice);
  await assert.rejects(appendReviewAction(bundle,session,{...input,candidateIds:[...candidateIds].reverse()},at),/blind order/);
 }
});

test("imports retain separate conflicting opinions and deduplicate identical journals",async()=>{
 const bundle=await fixture();
 const first=await appendReviewAction(bundle,await createReviewSession(bundle,"one","seed"),judgment(bundle,"would-take"),at);
 const second=await appendReviewAction(bundle,await createReviewSession(bundle,"two","seed"),judgment(bundle,"would-avoid"),at);
 const left=await reviewActionsFile(bundle,[first]),right=await reviewActionsFile(bundle,[second]);
 const merged=await mergeReviewActions(left,right,bundle);
 assert.deepEqual(merged.sessions.map(session=>session.actions[0].verdict),["would-take","would-avoid"]);
 assert.deepEqual(await mergeReviewActions(merged,right,bundle),merged);
 const longer=await appendReviewAction(bundle,first,{kind:"skip",caseId:bundle.cases[0].id},at);
 assert.equal((await mergeReviewActions(left,await reviewActionsFile(bundle,[longer]),bundle)).sessions[0].actions.length,2);
});

test("divergent edits to one session fail without overwriting either branch",async()=>{
 const bundle=await fixture(),session=await createReviewSession(bundle,"one","seed");
 const a=await reviewActionsFile(bundle,[await appendReviewAction(bundle,session,judgment(bundle,"would-take"),at)]);
 const b=await reviewActionsFile(bundle,[await appendReviewAction(bundle,session,judgment(bundle,"would-avoid"),at)]);
 const original=JSON.stringify([a,b]);
 await assert.rejects(mergeReviewActions(a,b,bundle),/conflicting session branches/);
 assert.equal(JSON.stringify([a,b]),original);
});

test("stale bundles, action edits and unknown candidate identities cannot acquire old opinions",async()=>{
 const bundle=await fixture(),session=await createReviewSession(bundle,"one","seed");
 const file=await reviewActionsFile(bundle,[await appendReviewAction(bundle,session,judgment(bundle),at)]);
 for(const mutate of [f=>{f.bundleId="c".repeat(64);},f=>{f.sessions[0].actions[0].notes="changed";},f=>{f.sessions[0].actions[0].candidateId="c".repeat(64);}]) {
  const changed=structuredClone(file);mutate(changed);
  await assert.rejects(validateReviewActions(changed,bundle),/stale|identity mismatch/);
 }
 const changed=structuredClone(bundle);changed.cases[0].candidates[0].itinerary.alightSecs++;
 await assert.rejects(appendReviewAction(changed,session,judgment(bundle),at),/identity mismatch/);
});

test("only explicit valid actions are exportable; drafts and invalid context reject",async()=>{
 const bundle=await fixture(),session=await createReviewSession(bundle,"one","seed");
 for(const input of [{...judgment(bundle),kind:"draft"},{...judgment(bundle),verdict:"correct"},{...judgment(bundle),confidence:"certain"},
  {...judgment(bundle),reasons:["other","other"]},{...judgment(bundle),extra:"unknown"}]) {
  await assert.rejects(appendReviewAction(bundle,session,input,at),/Invalid review actions/);
 }
 const skipped=await appendReviewAction(bundle,session,{kind:"skip",caseId:bundle.cases[0].id},at);
 assert.equal(effectiveReviewActions(skipped)[0].kind,"skip");
 await assert.rejects(appendReviewAction(bundle,session,judgment(bundle),"invalid time"),/time/);
});
