import {runWinnerCases} from "./winner_browser_kernel.mjs";
const MODES=["materialized","materialized-date-memo"];
export async function runDateMemoCases(input,hooks={}){
  if(!MODES.includes(input.options?.witnessComparison)||input.validation!=="session")throw Error("invalid date memo browser mode");
  let checks=0;
  const load=hooks.loadModule??(url=>import(url));
  const result=await runWinnerCases(input,{...hooks,loadModule:async url=>{
    const pkg=await load(url);
    // Same wrapper in both modes. Its fixed field check is included in the
    // outer call timer; no extra WASM call or hidden preprocessing is added.
    class Probe {
      constructor(...args){this.inner=new pkg.TemporalDeadlineProbe(...args);}
      prepare(...args){return this.inner.prepare(...args);}
      run_winners(...args){const r=this.inner.run_winners(...args);if(r.witnessDateMemoStackBytes!==64)throw Error("date memo stack accounting mismatch");checks++;return r;}
      run(...args){return this.inner.run(...args);}
      clear(){this.inner.clear();}
      free(){this.inner.free();}
    }
    return{...pkg,TemporalDeadlineProbe:Probe};
  }});
  if(!checks)throw Error("date memo stack checks missing");
  return{...result,witnessDateMemoStackBytes:64,memoScratchChecks:checks};
}
