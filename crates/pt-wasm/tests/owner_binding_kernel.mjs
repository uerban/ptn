import {validatePrefixInput} from "./prefix_progressive_kernel.mjs";
import {canonical} from "./deadline_browser_kernel.mjs";
export const OWNER_BINDINGS=["recompute","retained"];
export function validateOwnerInput(input){
  if(!OWNER_BINDINGS.includes(input.ownerBinding))throw Error("invalid owner binding policy");
  validatePrefixInput(input);
}
export function checkOwnerBindingInfo(info,policy,pointerBytes=4){
  const keys=["schema","policy","pointerBytes","ownerInlineBytes","probeInlineBytes","bindingSlotBytes","populatedBindingBytes","separateBindingAllocationBytes"];
  if(!OWNER_BINDINGS.includes(policy)||!info||canonical(Object.keys(info).sort())!==canonical(keys.sort())
      ||info.schema!=="immutable-owner-v1"||info.policy!==policy||info.pointerBytes!==pointerBytes
      ||keys.filter(k=>!["schema","policy"].includes(k)).some(k=>!Number.isSafeInteger(info[k])||info[k]<0)
      ||info.bindingSlotBytes<97||info.ownerInlineBytes<=info.bindingSlotBytes||info.probeInlineBytes<info.ownerInlineBytes
      ||info.populatedBindingBytes!==(policy==="retained"?97:0)||info.separateBindingAllocationBytes!==0)
    throw Error("actual owner binding/footprint drift");
  return info;
}
export function checkOwnerReady(ready,input){
  checkOwnerBindingInfo(ready.bindingInfo,input.ownerBinding);
  if(!Number.isFinite(ready.bindingDiagnosticMs)||ready.bindingDiagnosticMs<0)throw Error("owner diagnostic clock drift");
  return{info:ready.bindingInfo,diagnosticMs:ready.bindingDiagnosticMs};
}
