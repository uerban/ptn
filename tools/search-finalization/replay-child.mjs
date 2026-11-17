import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const [modulePath,recordPath,moduleHash,recordHash,plannerJson="null",walkingJson="null",rtJson="null"]=process.argv.slice(1);
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
    let timeFrame=null;
    if(record.timeFrame?.kind==="engine") {
      const resolved=await router.resolveTime(record.timeFrame.departureUnix);
      timeFrame={kind:"engine",departureUnix:record.timeFrame.departureUnix,...resolved};
      const expected=record.timeFrame;
      if(timeFrame.serviceDate!==expected.serviceDate||timeFrame.departureSecs!==expected.departureSecs||timeFrame.timeOriginUnix!==expected.timeOriginUnix)throw new Error("Engine time frame differs from observation");
    }
    const query=module.toWasmQuery(record.planner.query,record.planner.serviceDate);
    const observedQuery=JSON.parse(JSON.stringify(query));
    const actual=await router.plan(query);
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
    if(!Array.isArray(actual)||JSON.stringify(canonical(actual))!==JSON.stringify(canonical(record.planner.output)))throw new Error("Planner output differs from observation");
    planner={query:observedQuery,output:actual,artifacts,patternMode:config.patternMode,timeFrame};
  }finally{router?.free();}
}
let walking=null;
const walkConfig=JSON.parse(walkingJson);
if(walkConfig) {
  const bytes={},artifacts={};
  for(const [name,row] of Object.entries(walkConfig.artifacts)) {
    bytes[name]=readFileSync(row.path);if(digest(bytes[name])!==row.sha256)throw new Error("Materialized walking artifact changed");artifacts[name]=row.sha256;
  }
  const {walkingRequests}=await import(`data:text/javascript;base64,${bytes.walkingRequestBuilder.toString("base64")}`);
  const expected=walkingRequests(record,walkConfig.profile);
  // Separate module instance from any planner, even when both use the same glue.
  const pkg=await import(`data:text/javascript;base64,${bytes.walkingGlue.toString("base64")}#walking`);
  pkg.initSync({module:bytes.walkingWasm});
  let graph;
  try {
    graph=new pkg.PtWalkGraph(bytes.walkingGraph);
    if(graph.cityId()!==walkConfig.cityId)throw new Error("Walking graph city mismatch");
    const calls=[];
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
    for(const call of expected) {
      const route=await graph.route(call.from.lat,call.from.lon,call.to.lat,call.to.lon,walkConfig.profile);
      if(JSON.stringify(canonical(route))!==JSON.stringify(canonical(call.route)))throw new Error("Walking route differs from observation");
      calls.push({...call,route});
    }
    walking={calls,cityId:walkConfig.cityId,profile:walkConfig.profile,artifacts};
  }finally{graph?.free();}
}
let rt=null;
const rtConfig=JSON.parse(rtJson);
if(rtConfig) {
  const bytes={},artifacts={};
  for(const [name,row] of Object.entries(rtConfig.artifacts)) {bytes[name]=readFileSync(row.path);if(digest(bytes[name])!==row.sha256)throw new Error("Materialized RT artifact changed");artifacts[name]=row.sha256;}
  const decoder=await import(`data:text/javascript;base64,${bytes.rtModule.toString("base64")}`);
  const {rtDelayReads}=await import(`data:text/javascript;base64,${bytes.rtRequestBuilder.toString("base64")}`);
  const expected=rtDelayReads(record),events=JSON.parse(bytes.rtEvents).map(event=>event.kind==="update"?{kind:"update",receivedAt:event.receivedAt,bytes:bytes[`rtEnvelope${event.artifact}`]}:event);
  const values=decoder.replayRtEnvelopes(events,expected.map(read=>read.tripId));
  if(!Array.isArray(values)||values.length!==expected.length)throw new Error("RT decoder lookup count mismatch");
  const reads=expected.map((read,index)=>({tripId:read.tripId,value:values[index]}));
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
  if(JSON.stringify(canonical(reads))!==JSON.stringify(canonical(expected)))throw new Error("RT lookup differs from supplied envelope history");
  rt={reads,artifacts};
}
process.stdout.write(JSON.stringify({completion:"success",moduleHash,recordHash,output,planner,walking,rt})+"\n");
