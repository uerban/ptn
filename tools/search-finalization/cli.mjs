import {resolve} from "node:path";
import {buildRtModule} from "./rt-module.mjs";
import {buildFinalizationModule} from "./module.mjs";
import {retainFinalization,replayFinalizationCapsule,attachPlannerReplay,attachWalkingReplay,attachRtReplay} from "./capsule.mjs";
try {
  const [command,...args]=process.argv.slice(2);
  let result;
  if(command==="build"&&args.length===1)result=await buildFinalizationModule(resolve(args[0]));
  else if(command==="build-rt"&&args.length===1)result=await buildRtModule(resolve(args[0]));
  else if(command==="capture"&&args.length===4)result=retainFinalization(resolve(args[0]),args[1],resolve(args[2]),resolve(args[3]));
  else if(command==="attach-planner"&&args.length===8)result=attachPlannerReplay(resolve(args[0]),args[1],args[2],{glue:resolve(args[3]),wasm:resolve(args[4]),ptb:resolve(args[5]),transfers:args[6]==="none"?null:resolve(args[6]),patternMode:args[7]});
  else if(command==="attach-walking"&&args.length===8)result=attachWalkingReplay(resolve(args[0]),args[1],args[2],{glue:resolve(args[3]),wasm:resolve(args[4]),graph:resolve(args[5]),cityId:args[6],profile:args[7]});
  else if(command==="attach-rt"&&args.length===5)result=attachRtReplay(resolve(args[0]),args[1],args[2],{moduleDirectory:resolve(args[3]),eventsPath:resolve(args[4])});
  else if(command==="review"&&args.length===3)result=await (await import("./review.mjs")).exportCapsuleReview(resolve(args[0]),args[1],resolve(args[2]));
  else if(command==="review-compare"&&args.length===5)result=await (await import("./review.mjs")).exportCapsuleReviewComparison(resolve(args[0]),args[1],resolve(args[2]),args[3],resolve(args[4]));
  else if(command==="diff"&&args.length===4)result=(await import("./diff.mjs")).diffFinalizationCapsules(resolve(args[0]),args[1],resolve(args[2]),args[3]);
  else if(command==="replay"&&args.length===3)result=replayFinalizationCapsule(resolve(args[0]),args[1],resolve(args[2]));
  else throw new Error("usage: cli.mjs build <new-module-dir> | capture <store> <id> <record.json> <module-dir> | attach-planner <store> <source-id> <new-id> <glue.js> <wasm> <ptb> <transfers|none> <off|unbounded|covering-merge> | attach-walking <store> <source-id> <new-id> <glue.js> <wasm> <decoded.ptwg> <city> <default|wheelchair> | build-rt <new-module-dir> | attach-rt <store> <source-id> <new-id> <rt-module-dir> <events.json> | review <store> <id> <new-bundle.json> | review-compare <before-store> <before-id> <after-store> <after-id> <new-bundle.json> | diff <before-store> <before-id> <after-store> <after-id> | replay <store> <id> <new-output-dir>");
  console.log(JSON.stringify(result));if(command==="replay"&&result.completion!=="success")process.exitCode=1;
}catch(error){console.error(error.message);process.exitCode=1;}
