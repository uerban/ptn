import {runDateMemoCases} from "./date_memo_browser_kernel.mjs";
self.onmessage=async({data})=>{
  try{self.postMessage(await runDateMemoCases(data));}
  catch(error){self.postMessage({status:"failed",fatal:String(error)});}
};
