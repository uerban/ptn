import {resolve} from "node:path";
import {buildFinalizationModule} from "./module.mjs";
import {retainFinalization,replayFinalizationCapsule} from "./capsule.mjs";
try {
  const [command,...args]=process.argv.slice(2);
  let result;
  if(command==="build"&&args.length===1)result=await buildFinalizationModule(resolve(args[0]));
  else if(command==="capture"&&args.length===4)result=retainFinalization(resolve(args[0]),args[1],resolve(args[2]),resolve(args[3]));
  else if(command==="replay"&&args.length===3)result=replayFinalizationCapsule(resolve(args[0]),args[1],resolve(args[2]));
  else throw new Error("usage: cli.mjs build <new-module-dir> | capture <store> <id> <record.json> <module-dir> | replay <store> <id> <new-output-dir>");
  console.log(JSON.stringify(result));if(command==="replay"&&result.completion!=="success")process.exitCode=1;
}catch(error){console.error(error.message);process.exitCode=1;}
