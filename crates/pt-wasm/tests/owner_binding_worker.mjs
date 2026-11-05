import {createProgressiveHost,loadProgressiveOwner} from "./progressive_winner_worker.mjs";
import {OWNER_BINDINGS,checkOwnerBindingInfo} from "./owner_binding_kernel.mjs";
export function constructOwner(pkg,ptb,ptft,mode,policy){
  if(!OWNER_BINDINGS.includes(policy))throw Error("invalid owner binding policy");
  if(policy==="retained"){
    if(typeof pkg.TemporalDeadlineProbe.withImmutableBinding!=="function")throw Error("retained owner factory unavailable");
    return pkg.TemporalDeadlineProbe.withImmutableBinding(ptb,ptft,mode);
  }
  return new pkg.TemporalDeadlineProbe(ptb,ptft,mode);
}
export async function loadBindingOwner(input){
  if(!OWNER_BINDINGS.includes(input.ownerBinding))throw Error("invalid owner binding policy");
  const owner=await loadProgressiveOwner(input,(pkg,...args)=>constructOwner(pkg,...args,input.ownerBinding));
  try{
    const began=performance.now(),bindingInfo=owner.probe.owner_binding_info(),bindingDiagnosticMs=performance.now()-began;
    checkOwnerBindingInfo(bindingInfo,input.ownerBinding);
    return{...owner,bindingInfo,bindingDiagnosticMs};
  }catch(error){owner.probe.free();throw error;}
}
if(typeof self!=="undefined"&&typeof self.postMessage==="function"){
  const handle=createProgressiveHost({send:m=>self.postMessage(m),load:loadBindingOwner});
  self.onmessage=({data})=>{void handle(data).catch(error=>self.postMessage({type:"fatal",id:data.id,error:String(error)}));};
}
