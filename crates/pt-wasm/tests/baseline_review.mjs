import {readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {readArtifact} from "./baseline_store.mjs";
import {diffBaselines} from "./baseline_diff.mjs";
import {GLUE_EXECUTION} from "./baseline_glue.mjs";
import {fingerprint,validateReviewBundle,validateReviewStopContext} from "../../../tools/search-review/contract.mjs";

/** Explicit local export only. Raw input artifacts and machine paths stay in
 * the store. Query/candidate data may still be private; sharing is separate. */
export async function buildReviewBundle(store,runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("Invalid run ID");
  const manifest = readFileSync(join(store,"runs",`${runId}.json`));
  const record = JSON.parse(manifest);
  if (record.scope !== "stop-level compiled engine" || record.completion !== "success"
      || diffBaselines(record,record).status !== "unchanged") throw new Error("Capture has no supported successful comparison contract");
  // Do not turn a stale manifest into a portable claim of retained evidence.
  for (const hash of Object.values(record.artifacts)) readArtifact(store,hash);
  const {runtime,patternMode,objective,input} = record.report;
  const settings = {patternMode,objective,windowStart:input.windowStart,windowEnd:input.windowEnd};
  const provenance = {
    artifacts:record.artifacts,runtime,settings,
    snapshotId:await fingerprint({artifacts:record.artifacts,runtime,settings}),
    runManifestSha256:createHash("sha256").update(manifest).digest("hex"),
    classification:record.classification,replayVerification:record.replayVerification,
    executionContract:record.report.glueExecution??GLUE_EXECUTION.file,
    missingDependencies:record.missingDependencies,unsupported:record.unsupported,
  };
  const cases = [];
  for (const [index,tuple] of record.report.tuples.entries()) {
    const id = await fingerprint({snapshotId:provenance.snapshotId,query:tuple.query,index});
    const candidates = [];
    for (const itinerary of tuple.candidates) candidates.push({id:await fingerprint({caseId:id,itinerary}),itinerary});
    cases.push({id,query:tuple.query,capture:tuple.capture,candidates});
  }
  const content = {format:"ptn-search-review-bundle",version:1,scope:record.scope,provenance,cases};
  if(record.artifacts.reviewStopContext) {
    const context=validateReviewStopContext(JSON.parse(readArtifact(store,record.artifacts.reviewStopContext)),record.artifacts.ptb);
    const used=new Set();
    for(const row of cases) {
      for(const stop of [...(row.query.entryStops??[]),...(row.query.exitStops??[])]) used.add(stop.stopId);
      for(const candidate of row.candidates) for(const leg of candidate.itinerary.legs) {
        used.add(leg.fromStopId);used.add(leg.toStopId);
      }
    }
    content.stopContext={...context,stops:context.stops.filter(stop=>used.has(stop.stopId))};
  }
  const bundle = {...content,bundleId:await fingerprint(content)};
  await validateReviewBundle(bundle);
  return bundle;
}

export async function exportReviewBundle(store,runId,destination) {
  const bundle=await buildReviewBundle(store,runId);
  writeFileSync(destination,`${JSON.stringify(bundle,null,2)}\n`,{flag:"wx"});
  return bundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error("usage: baseline_review.mjs <store> <run-id> <new-bundle.json>");
    const bundle = await exportReviewBundle(resolve(process.argv[2]),process.argv[3],resolve(process.argv[4]));
    console.log(JSON.stringify({bundleId:bundle.bundleId,cases:bundle.cases.length}));
  } catch (error) {console.error(error.message);process.exitCode=1;}
}
