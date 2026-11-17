import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {buildReviewBundle} from "./baseline_review.mjs";
import {createReviewComparison} from "../../../tools/search-review/contract.mjs";

export async function exportReviewComparison(store,beforeId,afterId,destination) {
  const before=await buildReviewBundle(store,beforeId),after=await buildReviewBundle(store,afterId);
  const bundle=await createReviewComparison(before,after);
  writeFileSync(destination,JSON.stringify(bundle,null,2)+"\n",{flag:"wx",mode:0o600});
  return bundle;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==6) throw new Error("usage: baseline_review_compare.mjs <store> <before-run> <after-run> <new-bundle.json>");
    const bundle=await exportReviewComparison(resolve(process.argv[2]),process.argv[3],process.argv[4],resolve(process.argv[5]));
    console.log(JSON.stringify({bundleId:bundle.bundleId,cases:bundle.cases.length}));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
