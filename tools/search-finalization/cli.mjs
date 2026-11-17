import {resolve} from "node:path";
import {buildFinalizationModule} from "./module.mjs";
import {retainFinalization,replayFinalizationCapsule,attachPlannerReplay} from "./capsule.mjs";
try {
  const [command,...args]=process.argv.slice(2);
  let result;
  if(command==="build"&&args.length===1)result=await buildFinalizationModule(resolve(args[0]));
  else if(command==="capture"&&args.length===4)result=retainFinalization(resolve(args[0]),args[1],resolve(args[2]),resolve(args[3]));
  else if(command==="attach-planner"&&args.length===8)result=attachPlannerReplay(resolve(args[0]),args[1],args[2],{glue:resolve(args[3]),wasm:resolve(args[4]),ptb:resolve(args[5]),transfers:args[6]==="none"?null:resolve(args[6]),patternMode:args[7]});
  else if(command==="replay"&&args.length===3)result=replayFinalizationCapsule(resolve(args[0]),args[1],resolve(args[2]));
  else throw new Error("usage: cli.mjs build <new-module-dir> | capture <store> <id> <record.json> <module-dir> | attach-planner <store> <source-id> <new-id> <glue.js> <wasm> <ptb> <transfers|none> <off|unbounded|covering-merge> | replay <store> <id> <new-output-dir>");
  console.log(JSON.stringify(result));if(command==="replay"&&result.completion!=="success")process.exitCode=1;
}catch(error){console.error(error.message);process.exitCode=1;}
