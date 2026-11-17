import {test} from "node:test";
import assert from "node:assert/strict";
import {frontendFixture} from "../../../tools/search-review/frontend-fixture.mjs";
import {validateReviewBundle,createReviewComparison,createFrontendReviewBundle} from "../../../tools/search-review/contract.mjs";
import {createReviewSession,appendReviewAction,reviewActionsFile,validateReviewActions} from "../../../tools/search-review/state.mjs";
test("frontend raw walking and transit preserve duplicate occurrences and neutral actions",async()=>{
 const bundle=await frontendFixture();await validateReviewBundle(bundle);
 assert.equal(bundle.version,3);assert.equal(bundle.cases[0].candidates[0].itinerary.legs.length,0);
 assert.equal(new Set(bundle.cases[0].candidates.map(c=>c.id)).size,3);
 const owner=await createReviewSession(bundle,"test-only");
 assert.equal(owner.actions.length,0);
 const next=await appendReviewAction(bundle,owner,{kind:"skip",caseId:bundle.cases[0].id});
 await validateReviewActions(await reviewActionsFile(bundle,[next]),bundle);
 const changed=structuredClone(bundle);changed.cases[0].candidates[0].itinerary.totalSecs++;
 await assert.rejects(validateReviewBundle(changed),/identity/);
});
test("frontend blind comparisons retain both arrays including empty result source",async()=>{
 const before=await frontendFixture(),row=before.cases[0];
 const after=await createFrontendReviewBundle(before.provenance,row.query,row.context,[]);
 const bundle=await createReviewComparison(before,after);await validateReviewBundle(bundle);
 assert.equal(bundle.version,4);assert.equal(bundle.cases[0].comparisonStatus,"changed/unreviewed");
 assert.equal(bundle.cases[0].candidates.length,3);
 const bad=structuredClone(bundle);bad.cases[0].candidates.reverse();await assert.rejects(validateReviewBundle(bad),/derivation/);
});
test("frontend geometry is checked even when identities are recomputed",async()=>{
 const b=await frontendFixture(),r=b.cases[0],rows=r.candidates.map(({itinerary,evidence})=>({itinerary,evidence}));
 rows[0].itinerary.directWalk.route.coords[0][1]=91;
 const bad=await createFrontendReviewBundle(b.provenance,r.query,r.context,rows);
 await assert.rejects(validateReviewBundle(bad),/geometry/);
});
