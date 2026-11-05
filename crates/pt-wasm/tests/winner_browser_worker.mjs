import {runWinnerCases} from "./winner_browser_kernel.mjs";
self.onmessage=async({data})=>{
  try{self.postMessage(await runWinnerCases(data));}
  catch(error){self.postMessage({status:"failed",fatal:String(error)});}
};
