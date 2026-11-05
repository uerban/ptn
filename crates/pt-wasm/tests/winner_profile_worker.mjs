import {createWinnerProfile} from "./winner_profile_kernel.mjs";
let workload;
self.onmessage=async({data})=>{
  try {
    if(data.command==="init"&&!workload){workload=await createWinnerProfile(data.input);self.postMessage(workload.ready);}
    else if(data.command==="measure"&&workload)self.postMessage(workload.measure());
    else if(data.command==="finalize"&&workload){try{self.postMessage(workload.finalize());}finally{workload.dispose();}}
    else throw Error("invalid winner profile barrier");
  }catch(error){workload?.dispose();self.postMessage({status:"failed",fatal:String(error)});}
};
