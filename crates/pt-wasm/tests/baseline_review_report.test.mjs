import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fingerprint} from "../../../tools/search-review/contract.mjs";
import {createReviewSession,appendReviewAction,reviewActionsFile} from "../../../tools/search-review/state.mjs";
import {summarizeReviews} from "../../../tools/search-review/report.mjs";

async function fixture() {
  const artifacts=Object.fromEntries(["ptb","queryTuples","glue","wasm"].map(key=>[key,"a".repeat(64)]));
  const runtime={node:"test",v8:"test",platform:"test",arch:"test",release:"test"};
  const settings={patternMode:"covering-merge",objective:"plan",windowStart:null,windowEnd:null};
  const snapshotId=await fingerprint({artifacts,runtime,settings});
  const cases=[];
  for(let index=0;index<3;index++) {
    const query={departureSecs:index},id=await fingerprint({snapshotId,query,index});
    const candidates=[];
    for(let n=0;n<(index===2?0:2);n++) {
      const itinerary={legs:[],alightSecs:n};
      candidates.push({id:await fingerprint({caseId:id,itinerary}),itinerary});
    }
    cases.push({id,query,candidates,capture:{boundary:"stop-level engine",equivalence:"exact",truncated:index===1}});
  }
  const content={format:"ptn-search-review-bundle",version:1,scope:"stop-level compiled engine",
    provenance:{artifacts,runtime,settings,snapshotId,runManifestSha256:"b".repeat(64),classification:"partial capture",replayVerification:"unverified",missingDependencies:[],unsupported:[]},cases};
  return {...content,bundleId:await fingerprint(content)};
}
const at="2026-11-17T00:00:00Z";
const judge=(b,verdict)=>({kind:"judge",caseId:b.cases[0].id,candidateId:b.cases[0].candidates[0].id,verdict,confidence:"medium",familiarity:"unknown",reasons:[],notes:"private note"});

test("no feedback never becomes a neutral or positive verdict; empty and truncated cases remain",async()=>{
  const b=await fixture(),r=await summarizeReviews(b);
  assert.equal(r.evidenceStatus,"not-evaluated");assert.equal(r.qualityVerdict,null);
  assert.equal(r.counts.unreviewedCases,3);assert.equal(r.counts.emptyCases,1);assert.equal(r.counts.truncatedCases,1);
});

test("latest non-undone target opinion, skips and cannot judge have separate coverage",async()=>{
  const b=await fixture();let s=await createReviewSession(b,"alias","seed");
  s=await appendReviewAction(b,s,judge(b,"would-take"),at);
  s=await appendReviewAction(b,s,judge(b,"would-avoid"),at);
  s=await appendReviewAction(b,s,{kind:"undo",targetActionId:s.actions[1].id},at);
  s=await appendReviewAction(b,s,judge(b,"cannot-judge"),at);
  s=await appendReviewAction(b,s,{kind:"skip",caseId:b.cases[0].id},at);
  s=await appendReviewAction(b,s,{kind:"skip",caseId:b.cases[2].id},at);
  const file=await reviewActionsFile(b,[s]),before=JSON.stringify(file);
  const r=await summarizeReviews(b,[file,file]);
  assert.equal(JSON.stringify(file),before);assert.equal(r.counts.journalActions,6);
  assert.equal(r.counts.undoActions,1);assert.equal(r.counts.supersededOpinions,1);
  assert.equal(r.counts.opinions,1);assert.equal(r.counts.substantiveCases,0);
  assert.equal(r.counts.reviewedCases,1);assert.equal(r.counts.skippedOnlyCases,1);assert.equal(r.counts.unreviewedCases,1);
  assert.equal(r.cases[0].opinions[0].notes,"private note");
});

test("disagreement is retained by session without adjudication or alias independence claims",async()=>{
  const b=await fixture();const files=[];
  for(const [seed,verdict] of [["one","would-take"],["two","would-avoid"]]) {
    const s=await appendReviewAction(b,await createReviewSession(b,"same-alias",seed),judge(b,verdict),at);
    files.push(await reviewActionsFile(b,[s]));
  }
  const r=await summarizeReviews(b,files);
  assert.equal(r.counts.sessions,2);assert.equal(r.counts.reviewerAliases,1);assert.equal(r.counts.casesWithDivergentResponses,1);
  assert.equal(r.cases[0].opinions.length,2);assert.equal(r.qualityVerdict,null);
  assert.deepEqual(r,await summarizeReviews(b,[...files].reverse()));
});

test("pair responses compare candidate identity across independently blinded orders",async()=>{
  const b=await fixture(),files=[];const preferred=b.cases[0].candidates[0].id;
  for(let i=0;i<8;i++) {
    let s=await createReviewSession(b,String(i),String(i));
    const candidateIds=s.assignments[0].candidateIds;
    s=await appendReviewAction(b,s,{kind:"compare",caseId:b.cases[0].id,candidateIds,choice:candidateIds[0]===preferred?"A":"B",confidence:"high",familiarity:"unknown",reasons:[],notes:""},at);
    files.push(await reviewActionsFile(b,[s]));
  }
  const r=await summarizeReviews(b,files);assert.equal(r.counts.opinions,8);assert.equal(r.counts.casesWithDivergentResponses,0);
});

test("stale, tampered and forked journals fail rather than silently shrinking coverage",async()=>{
  const b=await fixture(),s=await createReviewSession(b,"one","seed");
  const a=await reviewActionsFile(b,[await appendReviewAction(b,s,judge(b,"would-take"),at)]);
  const fork=await reviewActionsFile(b,[await appendReviewAction(b,s,judge(b,"would-avoid"),at)]);
  await assert.rejects(summarizeReviews(b,[a,fork]),/conflicting/);
  const stale=structuredClone(a);stale.bundleId="c".repeat(64);
  await assert.rejects(summarizeReviews(b,[stale]),/stale/);
  const tampered=structuredClone(a);tampered.sessions[0].actions[0].notes="changed";
  await assert.rejects(summarizeReviews(b,[tampered]),/identity mismatch/);
});

test("repeated exports and prefix imports do not inflate yield; neutral pair answers survive",async()=>{
  const b=await fixture();let s=await createReviewSession(b,"alias","seed");
  const prefix=await reviewActionsFile(b,[s]);
  s=await appendReviewAction(b,s,{kind:"compare",caseId:b.cases[0].id,candidateIds:s.assignments[0].candidateIds,choice:"equivalent",confidence:"medium",familiarity:"unknown",reasons:[],notes:""},at);
  const file=await reviewActionsFile(b,[s]);
  const single=await summarizeReviews(b,[file]);
  assert.deepEqual(await summarizeReviews(b,[prefix,file,file,prefix]),single);
  assert.equal(single.counts.substantiveOpinions,1);assert.equal(single.counts.choiceCounts.equivalent,1);
});

test("CLI creates a private fresh output and refuses overwrite or invalid input",async()=>{
  const root=mkdtempSync(join(tmpdir(),"review-report-"));
  try {
    const input=join(root,"bundle.json"),output=join(root,"report.json");writeFileSync(input,JSON.stringify(await fixture()));
    const cli=new URL("../../../tools/search-review/report.mjs",import.meta.url);
    const run=()=>spawnSync(process.execPath,[cli.pathname,input,output],{encoding:"utf8"});
    assert.equal(run().status,0);assert.equal(statSync(output).mode&0o777,0o600);
    const bytes=readFileSync(output);assert.notEqual(run().status,0);assert.deepEqual(readFileSync(output),bytes);
    writeFileSync(input,"{}");assert.notEqual(run().status,0);assert.deepEqual(readFileSync(output),bytes);
  } finally {rmSync(root,{recursive:true,force:true});}
});
