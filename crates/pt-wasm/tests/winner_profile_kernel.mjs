// Diagnostic message-barrier workload. No profiler-off latency qualification.
import {canonical} from "./deadline_browser_kernel.mjs";
import {checkWinnerResult,winnerStable} from "./winner_browser_kernel.mjs";
const same=(a,b)=>canonical(a)===canonical(b);

export function validateProfileInput(input) {
  if(!["prepare","search"].includes(input.profilePhase)||!["latest-departure","portfolio"].includes(input.goal)
      ||input.validation!=="session"||input.verifyBoundary!==false||input.warmup!==2
      ||!Number.isSafeInteger(input.iterations)||input.iterations<1||input.iterations>100
      ||!Number.isSafeInteger(input.tupleIndex)||input.tupleIndex<0||input.tupleIndex>9
      ||input.tuples?.length!==10||input.expected?.length!==10||input.portfolioExpected?.length!==10
      ||input.expected[input.tupleIndex]?.status!=="completed"||input.portfolioExpected[input.tupleIndex]?.status!=="completed"
      ||!input.targetReference||!input.portfolioReference)throw Error("invalid winner profile input");
}

export async function createWinnerProfile(input,hooks={}) {
  validateProfileInput(input);
  const fetchBytes=hooks.fetchBytes??(async url=>{const r=await fetch(url);if(!r.ok)throw Error(`input HTTP ${r.status}`);return new Uint8Array(await r.arrayBuffer());});
  const pkg=await(hooks.loadModule??(url=>import(url)))("/pt_wasm.js");
  const [wasm,ptb,ptft]=await Promise.all([fetchBytes("/pt_wasm_bg.wasm"),fetchBytes("/bundle.ptb"),fetchBytes("/transfers.bin")]);
  const exports=await pkg.default({module_or_path:wasm});
  const probe=new pkg.TemporalDeadlineProbe(ptb,ptft,input.patternMode);
  let measured=false,finalized=false,disposed=false;
  const records=[],query={...input.tuples[input.tupleIndex],maxRounds:input.maxRounds};
  const options={...input.options,validation:"session",catalogue:"fresh"};
  const verify=(result,prepared,goal)=>{
    const expected=goal==="portfolio"?input.portfolioExpected[input.tupleIndex]:input.expected[input.tupleIndex];
    checkWinnerResult(result,prepared,expected,{goal,validation:"session",options});
    // Optional contract-specific checks run only during preflight/warmups or
    // finalize, never in the sampled measure loop.
    hooks.verifyResult?.(result);
    const stable=winnerStable(result),target=goal==="portfolio"?input.portfolioReference:input.targetReference;
    if(!same(stable,target))throw Error("winner profile same-target result/work/capacity drift");
    return stable;
  };
  const crossCheck=prepared=>({
    selected:verify(probe.run_winners(input.goal,"row-prefix"),prepared,input.goal),
    portfolio:verify(probe.run_winners("portfolio","row-prefix"),prepared,"portfolio"),
  });
  const dispose=()=>{if(!disposed){disposed=true;probe.free();}};
  try {
    let prepared=probe.prepare(query,options);
    const preflight=crossCheck(prepared);
    for(let i=0;i<input.warmup;i++){
      if(input.profilePhase==="prepare"){
        const next=probe.prepare(query,options);if(!same(prepared,next))throw Error("winner preparation warmup drift");prepared=next;
      }else verify(probe.run_winners(input.goal,"row-prefix"),prepared,input.goal);
    }
    const beforeLinearBytes=exports.memory.buffer.byteLength;
    return {
      ready:{status:"ready",tupleIndex:input.tupleIndex,profilePhase:input.profilePhase,goal:input.goal,preflight,prepared,beforeLinearBytes},
      measure(){
        if(disposed||measured)throw Error("winner profile window already used");measured=true;
        for(let i=0;i<input.iterations;i++){
          const began=performance.now();
          const value=input.profilePhase==="prepare"?probe.prepare(query,options):probe.run_winners(input.goal,"row-prefix");
          records.push({value,observedMs:performance.now()-began});
        }
        return{status:"measured",records:records.length};
      },
      finalize(){
        if(disposed||!measured||finalized||records.length!==input.iterations)throw Error("winner profile incomplete window");finalized=true;
        const observations=records.map(({value,observedMs})=>{
          if(!Number.isFinite(observedMs)||observedMs<0)throw Error("invalid winner profile observation");
          if(input.profilePhase==="prepare"){
            if(!same(value,prepared))throw Error("winner fresh preparation drift");
            return{observedMs,prepared:value};
          }
          return{observedMs,result:verify(value,prepared,input.goal),prepareMs:value.prepareMs,searchMs:value.searchMs,coreMs:value.coreMs};
        });
        const afterLinearBytes=exports.memory.buffer.byteLength;
        if(afterLinearBytes!==beforeLinearBytes)throw Error("winner profile window grew WASM memory");
        const postflight=crossCheck(prepared);
        if(!same(preflight,postflight))throw Error("winner profile pre/postflight drift");
        return{status:"matched",tupleIndex:input.tupleIndex,goal:input.goal,profilePhase:input.profilePhase,
          iterations:input.iterations,warmup:input.warmup,preflight,postflight,prepared,observations,beforeLinearBytes,afterLinearBytes};
      },
      dispose,
    };
  }catch(error){dispose();throw error;}
}
