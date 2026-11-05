import {executeSequence,primeIndex,SEQUENCES,POLICIES} from "./progressive_winner_kernel.mjs";
export async function loadProgressiveOwner(input,construct=(pkg,ptb,ptft,mode)=>new pkg.TemporalDeadlineProbe(ptb,ptft,mode)){
  const began=performance.now(),pkg=await import("/pt_wasm.js");
  const bytes=await Promise.all(["/pt_wasm_bg.wasm","/bundle.ptb","/transfers.bin"].map(async url=>{
    const r=await fetch(url);if(!r.ok)throw Error(`input HTTP ${r.status}`);return new Uint8Array(await r.arrayBuffer());
  }));
  const exports=await pkg.default({module_or_path:bytes[0]}),moduleLoadMs=performance.now()-began;
  const at=performance.now(),probe=construct(pkg,bytes[1],bytes[2],input.patternMode);
  return{probe,memory:()=>exports.memory.buffer.byteLength,moduleLoadMs,constructorMs:performance.now()-at};
}
export function createProgressiveHost({send,load=loadProgressiveOwner,now=()=>performance.now()}){
  let owner,input,busy=false,waiting=null,primed=null;
  return async m=>{
    if(m.type==="ack"){
      if(!waiting||m.id!==waiting.id||m.goal!==waiting.goal)throw Error("unexpected progressive acknowledgement");
      const done=waiting.resolve;waiting=null;done();return;
    }
    if(busy)throw Error("progressive worker busy");
    if(m.type==="init"){
      if(owner||!m.input||m.input.tuples?.length!==10)throw Error("invalid/duplicate initialization");
      busy=true;try{input=m.input;owner=await load(input);send({type:"ready",id:m.id,moduleLoadMs:owner.moduleLoadMs,
        constructorMs:owner.constructorMs,linearBytes:owner.memory(),
        ...(owner.bindingInfo?{bindingInfo:owner.bindingInfo,bindingDiagnosticMs:owner.bindingDiagnosticMs}:{})});}finally{busy=false;}return;
    }
    if(!owner)throw Error("progressive owner is not initialized");
    if(m.type==="close"){
      const at=now();owner.probe.free();owner=null;primed=null;send({type:"closed",id:m.id,ownerDropMs:now()-at});return;
    }
    if(m.type==="retire"){
      const at=now();owner.probe.clear();primed=null;
      send({type:"retired",id:m.id,workerMs:now()-at,afterLinearBytes:owner.memory()});return;
    }
    if(!Number.isInteger(m.tupleIndex)||m.tupleIndex<0||m.tupleIndex>=10||!POLICIES.includes(m.policy))throw Error("invalid request/control");
    if(m.type==="prime"){
      const index=primeIndex(input.tuples,m.tupleIndex,m.policy);let prepared=null;const at=now();
      if(index!==null){owner.probe.clear();prepared=owner.probe.prepare({...input.tuples[index],maxRounds:input.maxRounds},{...input.options,catalogue:"fresh"});}
      primed={tupleIndex:m.tupleIndex,policy:m.policy};send({type:"primed",id:m.id,index,prepared,workerMs:now()-at});return;
    }
    if(m.type!=="run"||!SEQUENCES.includes(m.sequence)||!primed||primed.tupleIndex!==m.tupleIndex||primed.policy!==m.policy)throw Error("unprimed/invalid sequence request");
    primed=null;busy=true;
    try{
      const beforeLinearBytes=owner.memory();
      const r=await executeSequence(owner.probe,{...input.tuples[m.tupleIndex],maxRounds:input.maxRounds},input.options,m.sequence,m.policy,
        {now,deliver:(goal,payload)=>new Promise(resolve=>{waiting={id:m.id,goal,resolve};send({type:"stage",id:m.id,goal,...payload});})});
      busy=false;
      send(r.status==="completed"?{type:"done",id:m.id,status:"completed",beforeLinearBytes,afterLinearBytes:owner.memory()}
        :{type:"done",id:m.id,...r});
    }finally{busy=false;}
  };
}
if(typeof self!=="undefined"&&typeof self.postMessage==="function"){
  const handle=createProgressiveHost({send:m=>self.postMessage(m)});
  self.onmessage=({data})=>{void handle(data).catch(error=>self.postMessage({type:"fatal",id:data.id,error:String(error)}));};
}
