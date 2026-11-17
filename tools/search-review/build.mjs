import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
const here=dirname(fileURLToPath(import.meta.url));
function moduleBody(name) {
  return readFileSync(join(here,name),"utf8").replace(/^import .*;\n/gm,"").replace(/^export /gm,"");
}
export function buildReviewerPage() {
  const contract=`const contract=(()=>{${moduleBody("contract.mjs")}\nreturn {canonical,fingerprint,validateReviewBundle};})();`;
  const state=`const state=(()=>{const {canonical,fingerprint,validateReviewBundle}=contract;${moduleBody("state.mjs")}\nreturn {VERDICTS,CHOICES,REASONS,createReviewSession,appendReviewAction,effectiveReviewActions,reviewActionsFile,validateReviewActions,mergeReviewActions};})();`;
  const app=`(()=>{const {validateReviewBundle}=contract;const {VERDICTS,CHOICES,REASONS,createReviewSession,appendReviewAction,effectiveReviewActions,reviewActionsFile,validateReviewActions,mergeReviewActions}=state;${moduleBody("app.mjs")}\n})();`;
  const script=[contract,state,app].join("\n").replace(/<\/script/gi,"<\\/script");
  const hash=createHash("sha256").update(script).digest("base64");
  return readFileSync(join(here,"page.html"),"utf8").replace("__SCRIPT_HASH__",hash).replace("__SCRIPT__",()=>script);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const generated=buildReviewerPage(),path=join(here,"index.html");
  if(process.argv.includes("--check")) {
    if(readFileSync(path,"utf8")!==generated) throw new Error("Reviewer page is stale; run node tools/search-review/build.mjs");
  } else writeFileSync(path,generated);
}
