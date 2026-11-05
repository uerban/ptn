// Existing exact searches only. No engine state, incumbent or prefix sharing.
import {canonical,percentile} from "./deadline_browser_kernel.mjs";
import {checkWinnerResult,winnerStable} from "./winner_browser_kernel.mjs";
export const SEQUENCES=["portfolio","latest-then-portfolio"];
export const POLICIES=["fresh","hit","miss"];
export const goalsFor=s=>s==="latest-then-portfolio"?["latest-departure","portfolio"]:["portfolio"];
const same=(a,b)=>canonical(a)===canonical(b),finite=n=>Number.isFinite(n)&&n>=0;
export function primeIndex(tuples,i,policy){
  if(policy==="fresh")return null;
  const j=tuples.findIndex((q,j)=>j!==i&&(q.date===tuples[i].date)===(policy==="hit"));
  if(j<0)throw Error("missing same-date/different-date priming tuple");return j;
}
export function validateInput(x){
  if(!SEQUENCES.includes(x.sequence)||!POLICIES.includes(x.policy)||x.tuples?.length!==10
      ||x.latest?.length!==10||x.portfolio?.length!==10||x.maxRounds!==4||x.patternMode!=="covering-merge"
      ||!Number.isSafeInteger(x.iterations)||x.iterations<1||x.iterations>1000
      ||!Number.isSafeInteger(x.warmup)||x.warmup<0||x.warmup>1000)throw Error("invalid progressive workload");
  const want={objective:"m4",lookup:"lazy-cached",validation:"session",traversal:"arrival-first",
    witnessComparison:"materialized-date-memo",frontierStorage:"event-indexed",prefixBound:true,pointBound:true,
    staticBound:false,walkingBound:false,forwardSeeds:false,maxSegments:250000,maxFrontierWidth:64,
    maxStopScans:10000000,maxLookupWork:10000000};
  if(Object.entries(want).some(([k,v])=>x.options?.[k]!==v)||Object.keys(x.options).some(k=>!(k in want)&&!["windowStart","windowEnd","arrivalDeadline"].includes(k))
      ||![x.options.windowStart,x.options.windowEnd,x.options.arrivalDeadline].every(Number.isSafeInteger)
      ||x.options.windowEnd<=x.options.windowStart)throw Error("progressive options/caps drift");
  for(let i=0;i<10;i++){
    if(x.latest[i].tupleIndex!==i||x.portfolio[i].tupleIndex!==i
        ||x.latest[i].date!==x.tuples[i].date||x.portfolio[i].date!==x.tuples[i].date)throw Error("progressive tuple drift");
    primeIndex(x.tuples,i,x.policy);
  }
}
export async function executeSequence(probe,query,options,sequence,policy,{now=()=>performance.now(),deliver}={}){
  if(!SEQUENCES.includes(sequence)||!POLICIES.includes(policy)||typeof deliver!=="function")throw Error("invalid sequence hooks");
  let stage="prepare",latestCompleted=false;const stages=[];
  try{
    const began=now();if(policy==="fresh")probe.clear();
    const prepared=probe.prepare(query,{...options,catalogue:policy==="fresh"?"fresh":"reuse"});
    const preparationMs=now()-began;
    for(const goal of goalsFor(sequence)){
      stage=goal;const at=now(),result=probe.run_winners(goal,"row-prefix"),callMs=now()-at;
      if(result.complete!==true||result.queryKind!==goal)throw Error("incomplete/wrong selector output");
      if(goal==="latest-departure")latestCompleted=true;
      const payload={prepared,result,preparationMs,callMs};stages.push(payload);
      // Delivery includes an explicit frame-opportunity acknowledgement.
      await deliver(goal,payload);
    }
    return{status:"completed",stages};
  }catch(error){return{status:"failed",stage,error:String(error),firstStageCompleted:latestCompleted};}
}
export function checkStage(payload,input,i,goal,prime){
  const expected=goal==="portfolio"?input.portfolio[i]:input.latest[i],p=payload.prepared;
  if(p.catalogueMode!==(input.policy==="fresh"?"fresh":"reuse")||p.catalogueReused!==(input.policy==="hit"))throw Error("catalogue policy/hit drift");
  if(input.policy!=="fresh"&&(!prime||same(prime.catalogueKey,p.catalogueKey)!==(input.policy==="hit")
      ||prime.catalogueMode!=="fresh"||prime.catalogueReused!==false))throw Error("priming identity drift");
  // Older checker remains strict; normalize only the separately proved policy.
  checkWinnerResult(payload.result,{...p,catalogueMode:"fresh",catalogueReused:false},expected,
    {goal,validation:"session",options:input.options});
  if(payload.result.witnessDateMemoStackBytes!==64||!finite(payload.callMs)||!finite(payload.preparationMs)
      ||payload.callMs+.1<payload.result.coreMs)throw Error("progressive call/phase/scratch drift");
}
export function aggregateWork(stages){
  return Object.fromEntries(["lookupWork","stopWork","segments","segmentsScanned"].map(k=>[k,stages.reduce((n,s)=>n+s.result.counters[k],0)]));
}
export function stripSample(r){
  return{preconditioningMs:r.preconditioningMs,primingWorkerMs:r.primingWorkerMs,preparationMs:r.stages[0].preparationMs,
    firstReceiveMs:r.stages[0].receiveMs,firstFrameMs:r.stages[0].frameMs,
    finalReceiveMs:r.stages.at(-1).receiveMs,finalFrameMs:r.stages.at(-1).frameMs,requestDoneMs:r.requestDoneMs,
    unamortizedFinalMs:r.preconditioningMs+r.stages.at(-1).frameMs,
    firstUseful: Object.values(r.stages[0].result.winners).some(p=>p!==null),
    stages:r.stages.map(s=>({goal:s.result.queryKind,callMs:s.callMs,corePrepareMs:s.result.prepareMs,
      coreSearchMs:s.result.searchMs,coreMs:s.result.coreMs,receiveMs:s.receiveMs,frameMs:s.frameMs})),
    aggregateWork:aggregateWork(r.stages),timerGapsMs:r.timerGapsMs,frameGapsMs:r.frameGapsMs,
    beforeLinearBytes:r.beforeLinearBytes,afterLinearBytes:r.afterLinearBytes};
}
export function checkSample(s,sequence){
  const goals=goalsFor(sequence),st=s.stages;
  const keys=["preconditioningMs","primingWorkerMs","preparationMs","firstReceiveMs","firstFrameMs","finalReceiveMs","finalFrameMs","requestDoneMs","unamortizedFinalMs","firstUseful","stages","aggregateWork","timerGapsMs","frameGapsMs","beforeLinearBytes","afterLinearBytes"];
  if(!SEQUENCES.includes(sequence)||!same(Object.keys(s).sort(),keys.sort())||!same(st?.map(r=>r.goal),goals)||[s.preconditioningMs,s.primingWorkerMs,s.preparationMs,s.firstReceiveMs,s.firstFrameMs,s.finalReceiveMs,s.finalFrameMs,s.requestDoneMs,s.unamortizedFinalMs].some(n=>!finite(n))
      ||typeof s.firstUseful!=="boolean"||!same(s.aggregateWork&&Object.keys(s.aggregateWork).sort(),["lookupWork","segments","segmentsScanned","stopWork"])
      ||Object.values(s.aggregateWork).some(n=>!Number.isSafeInteger(n)||n<0))throw Error("progressive sample schema/work drift");
  let before=0;
  for(const r of st){
    if(!same(Object.keys(r).sort(),["goal","callMs","corePrepareMs","coreSearchMs","coreMs","receiveMs","frameMs"].sort())
        ||[r.callMs,r.corePrepareMs,r.coreSearchMs,r.coreMs,r.receiveMs,r.frameMs].some(n=>!finite(n))||r.corePrepareMs+r.coreSearchMs>r.coreMs+.001
        ||r.coreMs>r.callMs+.1||r.receiveMs<before||r.frameMs<r.receiveMs)throw Error("progressive stage order/phase drift");
    before=r.frameMs;
  }
  if(s.firstReceiveMs!==st[0].receiveMs||s.firstFrameMs!==st[0].frameMs||s.finalReceiveMs!==st.at(-1).receiveMs
      ||s.finalFrameMs!==st.at(-1).frameMs||s.requestDoneMs<s.finalFrameMs||s.unamortizedFinalMs!==s.preconditioningMs+s.finalFrameMs
      ||s.preparationMs+st.reduce((n,r)=>n+r.callMs,0)>s.finalFrameMs+1||s.primingWorkerMs>s.preconditioningMs+1
      ||[s.timerGapsMs,s.frameGapsMs].some(a=>!Array.isArray(a)||a.some(n=>!finite(n)))
      ||s.afterLinearBytes<s.beforeLinearBytes||[s.beforeLinearBytes,s.afterLinearBytes].some(n=>!Number.isSafeInteger(n)||n<65536||n%65536))throw Error("progressive timeline/raw accounting drift");
}
export function timingSummary(samples){
  return Object.fromEntries(["firstFrameMs","finalFrameMs","unamortizedFinalMs"].map(k=>[k,{p50Ms:percentile(samples.map(s=>s[k]),.5),p95Ms:percentile(samples.map(s=>s[k]),.95)}]));
}
export {winnerStable};
