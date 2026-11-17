import {readFileSync,writeFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {fingerprint,validateReviewBundle} from "./contract.mjs";
import {effectiveReviewActions,mergeReviewActions,reviewActionsFile} from "./state.mjs";

/** Descriptive coverage of explicit imported actions, never a quality score.
 * Session identity is not proof of a distinct person. Full journals stay in
 * the source exports; this view retains the latest non-undone opinion per
 * session and target. A skip cannot erase an earlier opinion. */
export async function summarizeReviews(bundle,files=[]) {
  await validateReviewBundle(bundle);
  let merged=await reviewActionsFile(bundle,[]);
  for(const file of files) merged=await mergeReviewActions(merged,file,bundle);
  merged.sessions.sort((a,b)=>a.id.localeCompare(b.id));
  const cases=bundle.cases.map(row=>({caseId:row.id,candidateCount:row.candidates.length,
    truncated:row.capture.truncated,opinions:[],skips:[]}));
  const byId=new Map(cases.map(row=>[row.caseId,row]));
  let journalActions=0,undoActions=0,supersededOpinions=0;
  for(const session of merged.sessions) {
    journalActions+=session.actions.length;
    undoActions+=session.actions.filter(action=>action.kind==="undo").length;
    const latest=new Map();
    for(const action of effectiveReviewActions(session)) {
      const row=byId.get(action.caseId);
      const identity={sessionId:session.id,reviewerId:session.reviewerId};
      if(action.kind==="skip") {
        row.skips.push({...identity,actionId:action.id,at:action.at});
        continue;
      }
      const target=action.kind==="judge" ? action.candidateId : [...action.candidateIds].sort().join(":");
      const key=`${action.caseId}:${action.kind}:${target}`;
      if(latest.has(key)) supersededOpinions++;
      latest.set(key,{...identity,...structuredClone(action)});
    }
    for(const opinion of latest.values()) byId.get(opinion.caseId).opinions.push(opinion);
  }
  const verdictCounts={},choiceCounts={};
  let opinions=0,substantiveOpinions=0,reviewedCases=0,substantiveCases=0,skippedOnlyCases=0;
  for(const row of cases) {
    opinions+=row.opinions.length;
    const substantive=row.opinions.filter(opinion=>(opinion.verdict??opinion.choice)!=="cannot-judge");
    substantiveOpinions+=substantive.length;
    reviewedCases+=Number(row.opinions.length>0);
    substantiveCases+=Number(substantive.length>0);
    skippedOnlyCases+=Number(!row.opinions.length&&row.skips.length>0);
    for(const opinion of row.opinions) {
      const counts=opinion.kind==="judge"?verdictCounts:choiceCounts;
      const value=opinion.verdict??opinion.choice;
      counts[value]=(counts[value]??0)+1;
    }
    // Different responses are visible, not adjudicated. Pair A/B is converted
    // back to candidate identity before comparing differently blinded sessions.
    const responses=new Map();
    for(const opinion of row.opinions) {
      const target=opinion.kind==="judge"?`judge:${opinion.candidateId}`:`compare:${[...opinion.candidateIds].sort().join(":")}`;
      const value=opinion.kind==="judge"?opinion.verdict:
        opinion.choice==="A"?opinion.candidateIds[0]:opinion.choice==="B"?opinion.candidateIds[1]:opinion.choice;
      if(!responses.has(target)) responses.set(target,new Set());
      responses.get(target).add(value);
    }
    row.divergentTargets=[...responses].filter(([,values])=>values.size>1).map(([target])=>target);
    row.status=row.opinions.length?"reviewed":row.skips.length?"skipped-only":"unreviewed";
  }
  return {format:"ptn-search-review-report",version:1,bundleId:bundle.bundleId,
    actionsSha256:await fingerprint(merged),scope:bundle.scope,
    evidenceStatus:opinions?"imported-explicit-opinions":"not-evaluated",
    qualityVerdict:null,
    counts:{cases:cases.length,emptyCases:cases.filter(row=>row.candidateCount===0).length,
      truncatedCases:cases.filter(row=>row.truncated).length,sessions:merged.sessions.length,
      reviewerAliases:new Set(merged.sessions.map(session=>session.reviewerId)).size,
      journalActions,undoActions,supersededOpinions,opinions,substantiveOpinions,
      reviewedCases,substantiveCases,skippedOnlyCases,unreviewedCases:cases.length-reviewedCases-skippedOnlyCases,
      casesWithDivergentResponses:cases.filter(row=>row.divergentTargets.length).length,
      verdictCounts,choiceCounts},
    limitations:["Aliases and sessions do not prove independent human reviewers.",
      "Counts describe this imported bundle, not citywide satisfaction or correctness.",
      "Cannot-judge counts as an explicit opinion but not a substantive assessment.",
      "No demand weights, preference-rate inference or automatic baseline promotion."],cases};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [bundlePath,outputPath,...actionPaths]=process.argv.slice(2);
    if(!bundlePath||!outputPath) throw new Error("Usage: report.mjs <bundle.json> <new-report.json> [actions.json ...]");
    const load=path=>JSON.parse(readFileSync(path,"utf8"));
    const report=await summarizeReviews(load(bundlePath),actionPaths.map(load));
    writeFileSync(outputPath,JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
