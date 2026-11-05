import {runProgressivePage as runBase} from "./progressive_winner_page.mjs";
import {validateOwnerInput,checkOwnerReady} from "./owner_binding_kernel.mjs";
import {checkPrefixStage,checkPrefixSample,prefixStable,prefixTimingSummary} from "./prefix_progressive_kernel.mjs";
export const runProgressivePage=input=>runBase(input,{validate:validateOwnerInput,validateStage:checkPrefixStage,
  validateSample:checkPrefixSample,stableResult:prefixStable,summarize:prefixTimingSummary,retireAfterRequest:true,
  workerUrl:"/owner_binding_worker.mjs",ownerInput:x=>({tuples:x.tuples,options:x.options,maxRounds:x.maxRounds,patternMode:x.patternMode,ownerBinding:x.ownerBinding}),
  validateOwnerReady:checkOwnerReady});
