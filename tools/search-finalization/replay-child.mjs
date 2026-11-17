import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const [modulePath,recordPath,moduleHash,recordHash,plannerJson="null"]=process.argv.slice(1);
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const moduleBytes=readFileSync(modulePath),recordBytes=readFileSync(recordPath);
if(digest(moduleBytes)!==moduleHash||digest(recordBytes)!==recordHash)throw new Error("Materialized replay artifact changed");
// Import the observed module bytes, not a second read of its pathname.
const module=await import(`data:text/javascript;base64,${moduleBytes.toString("base64")}`);
const record=JSON.parse(recordBytes);
const methods={"ptn-search-finalization":"replayFinalization","ptn-search-composition":"replaySearchComposition","ptn-search-reach":"replayReachableStops","ptn-search-pipeline":"replaySearchPipeline"};
const method=methods[record.format];
if(!method)throw new Error("Unsupported retained record format");
const output=await module[method](record);
let planner=null;
const config=JSON.parse(plannerJson);
if(config) {
  if(record.format!=="ptn-search-pipeline"||!record.planner||typeof module.toWasmQuery!=="function")throw new Error("Planner replay is unavailable");
  const bytes={},artifacts={};
  for(const [name,row] of Object.entries(config.artifacts)) {
    bytes[name]=readFileSync(row.path);if(digest(bytes[name])!==row.sha256)throw new Error("Materialized planner artifact changed");artifacts[name]=row.sha256;
  }
  const pkg=await import(`data:text/javascript;base64,${bytes.plannerGlue.toString("base64")}`);
  pkg.initSync({module:bytes.plannerWasm});
  let router;
  try {
    router=new pkg.PtRouter(bytes.plannerPtb,config.patternMode);
    if(typeof router.temporalDirectObjective==="function"&&router.temporalDirectObjective()!==null)throw new Error("Experimental planner objective is unsupported");
    if(config.transfers)await router.setTransfers(bytes.plannerTransfers);
    const query=module.toWasmQuery(record.planner.query,record.planner.serviceDate);
    const observedQuery=JSON.parse(JSON.stringify(query));
    const actual=await router.plan(query);
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
    if(!Array.isArray(actual)||JSON.stringify(canonical(actual))!==JSON.stringify(canonical(record.planner.output)))throw new Error("Planner output differs from observation");
    planner={query:observedQuery,output:actual,artifacts,patternMode:config.patternMode};
  }finally{router?.free();}
}
process.stdout.write(JSON.stringify({completion:"success",moduleHash,recordHash,output,planner})+"\n");
