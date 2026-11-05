import {validateInput,goalsFor,primeIndex,checkStage,stripSample,checkSample,timingSummary,winnerStable} from "./progressive_winner_kernel.mjs";
import {canonical} from "./deadline_browser_kernel.mjs";
const same=(a,b)=>canonical(a)===canonical(b);
const frame=()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(ok)));
function render(goal,result){
  const unique=[...new Set(Object.values(result.winners).filter(p=>p!==null).map(p=>canonical(p)))];
  document.getElementById("result").textContent=`${goal}: ${unique.length} distinct route(s)\n`+unique.join("\n");
}
function heartbeat(){
  const timerGapsMs=[],frameGapsMs=[];let lastTimer=performance.now(),lastFrame=lastTimer,raf;
  const interval=setInterval(()=>{const n=performance.now();timerGapsMs.push(n-lastTimer);lastTimer=n;},10);
  const tick=()=>{const n=performance.now();frameGapsMs.push(n-lastFrame);lastFrame=n;raf=requestAnimationFrame(tick);};
  raf=requestAnimationFrame(tick);
  return()=>{clearInterval(interval);cancelAnimationFrame(raf);return{timerGapsMs,frameGapsMs};};
}
export async function runProgressivePage(input,{
  validate=validateInput,validateStage=checkStage,validateSample=checkSample,summarize=timingSummary,
  stableResult=r=>({...winnerStable(r),witnessDateMemoStackBytes:r.witnessDateMemoStackBytes}),
  retireAfterRequest=false,
  workerUrl="/progressive_winner_worker.mjs",
  ownerInput=x=>({tuples:x.tuples,options:x.options,maxRounds:x.maxRounds,patternMode:x.patternMode}),
  validateOwnerReady,
}={}){
  validate(input);const worker=new Worker(workerUrl,{type:"module"});
  let serial=0,pending=null;
  const rpc=(message,onStage)=>new Promise((resolve,reject)=>{
    if(pending){reject(Error("overlapping page request"));return;}
    const id=++serial,timeout=setTimeout(()=>{pending=null;reject(Error("progressive worker observation timeout"));},120000);
    pending={id,onStage,resolve:r=>{clearTimeout(timeout);pending=null;resolve(r);},reject:e=>{clearTimeout(timeout);pending=null;reject(e);}};
    worker.postMessage({...message,id});
  });
  worker.onerror=e=>pending?.reject(Error(e.message));
  worker.onmessage=({data:m})=>{
    if(!pending||pending.id!==m.id){pending?.reject(Error("stale/unsolicited worker output"));return;}
    if(m.type==="fatal"){pending.reject(Error(m.error));return;}
    if(m.type==="stage"){
      if(!pending.onStage){pending.reject(Error("unexpected stage output"));return;}
      void pending.onStage(m).then(()=>worker.postMessage({type:"ack",id:m.id,goal:m.goal})).catch(e=>pending?.reject(e));
    }else pending.resolve(m);
  };
  const run=async i=>{
    const controlAt=performance.now(),prime=await rpc({type:"prime",tupleIndex:i,policy:input.policy});
    if(prime.type!=="primed"||prime.index!==primeIndex(input.tuples,i,input.policy))throw Error("priming protocol drift");
    const stop=heartbeat(),stages=[],began=performance.now();let done,gaps;
    try{
      done=await rpc({type:"run",tupleIndex:i,policy:input.policy,sequence:input.sequence},async m=>{
        const receiveMs=performance.now()-began,goal=goalsFor(input.sequence)[stages.length];
        if(m.goal!==goal||m.result?.complete!==true||m.result?.queryKind!==goal)throw Error("stage proof/order drift");
        render(m.goal,m.result);await frame();stages.push({...m,receiveMs,frameMs:performance.now()-began});
      });
    }finally{gaps=stop();}
    const requestDoneMs=performance.now()-began;
    if(done.type!=="done")throw Error("missing request completion");
    let retired,retirementRoundtripMs,retirementStartMs,requestWithRetirementMs;
    if(retireAfterRequest){
      const at=performance.now();retirementStartMs=at-began;retired=await rpc({type:"retire"});
      const ended=performance.now();retirementRoundtripMs=ended-at;requestWithRetirementMs=ended-began;
      if(retired.type!=="retired"||!Number.isFinite(retired.workerMs)||retired.workerMs<0
          ||retired.workerMs>retirementRoundtripMs+1)throw Error("request retirement protocol drift");
    }
    if(done.status==="failed"){
      const expected=done.stage==="latest-departure"?input.latest[i]:input.portfolio[i];
      if(expected.status!=="failed"||done.error!==`Error: deadline winner query: ${expected.error}`
          ||done.firstStageCompleted!==(input.sequence==="latest-then-portfolio"&&stages.length===1))throw Error("unexpected/partial failed sequence");
      return{tupleIndex:i,status:"failed",stage:done.stage,error:done.error,firstStageCompleted:done.firstStageCompleted};
    }
    if(done.status!=="completed"||stages.length!==goalsFor(input.sequence).length)throw Error("incomplete sequence");
    for(const s of stages)validateStage(s,input,i,s.goal,prime.prepared);
    const r={stages,...gaps,requestDoneMs,preconditioningMs:began-controlAt,primingWorkerMs:prime.workerMs,beforeLinearBytes:done.beforeLinearBytes,afterLinearBytes:done.afterLinearBytes};
    const sample={...stripSample(r),...(retireAfterRequest?{retirementWorkerMs:retired.workerMs,retirementRoundtripMs,retirementStartMs,
      requestWithRetirementMs,afterRetirementLinearBytes:retired.afterLinearBytes}:{})};
    validateSample(sample,input.sequence);
    return{status:"completed",sample,prepared:stages[0].prepared,prime:{index:prime.index,prepared:prime.prepared,workerMs:prime.workerMs},
      results:stages.map(s=>stableResult(s.result))};
  };
  try{
    const began=performance.now(),ready=await rpc({type:"init",input:ownerInput(input)});
    const ownerReadyMs=performance.now()-began;
    if(ready.type!=="ready")throw Error("owner initialization failed");
    const ownerBinding=validateOwnerReady?.(ready,input);
    const rows=[];
    for(let i=0;i<10;i++){
      const first=await run(i);
      if(first.status==="failed"){rows.push(first);continue;}
      const repeat=async()=>{const r=await run(i);if(r.status!=="completed"||!same(r.results,first.results)||!same(r.prepared,first.prepared)
          ||!same(r.prime.prepared,first.prime.prepared))throw Error("sequence repeat/canonical/work drift");return r.sample;};
      const warmups=[];for(let n=0;n<input.warmup;n++)warmups.push(await repeat());
      const samples=[];for(let n=0;n<input.iterations;n++)samples.push(await repeat());
      rows.push({tupleIndex:i,status:"completed",results:first.results,prepared:first.prepared,prime:first.prime,
        first:first.sample,warmups,samples,summary:summarize(samples)});
    }
    const closed=await rpc({type:"close"});if(closed.type!=="closed")throw Error("owner retirement failed");
    return{status:"matched",ownerReadyMs,ownerDropMs:closed.ownerDropMs,moduleLoadMs:ready.moduleLoadMs,
      constructorMs:ready.constructorMs,initialOwnerLinearBytes:ready.linearBytes,queries:rows,
      ...(ownerBinding?{ownerBinding}:{})};
  }finally{worker.terminate();}
}
