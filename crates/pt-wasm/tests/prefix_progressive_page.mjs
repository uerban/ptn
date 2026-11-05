import {runProgressivePage as runBase} from "./progressive_winner_page.mjs";
import {validatePrefixInput,checkPrefixStage,checkPrefixSample,prefixStable,prefixTimingSummary} from "./prefix_progressive_kernel.mjs";
export const runProgressivePage=input=>runBase(input,{validate:validatePrefixInput,validateStage:checkPrefixStage,
  validateSample:checkPrefixSample,stableResult:prefixStable,summarize:prefixTimingSummary,retireAfterRequest:true});
