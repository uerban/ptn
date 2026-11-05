import {createWinnerProfile,validateProfileInput} from "./winner_profile_kernel.mjs";
export function validateDateMemoProfileInput(input){
  validateProfileInput(input);
  if(input.options?.witnessComparison!=="materialized-date-memo"
      ||input.targetReference?.witnessComparison!=="materialized-date-memo"
      ||input.portfolioReference?.witnessComparison!=="materialized-date-memo")throw Error("invalid date-memo profile contract");
}
export async function createDateMemoProfile(input,hooks={}){
  validateDateMemoProfileInput(input);let checks=0;
  const workload=await createWinnerProfile(input,{...hooks,verifyResult:r=>{
    if(r.witnessComparison!=="materialized-date-memo"||r.witnessDateMemoStackBytes!==64)throw Error("date-memo profile scratch/mode mismatch");
    checks++;hooks.verifyResult?.(r);
  }});
  return{...workload,finalize(){const result=workload.finalize();
    return{...result,witnessDateMemoStackBytes:64,memoScratchChecks:checks};}};
}
