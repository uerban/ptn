import { runDeadlineCases } from "./deadline_browser_kernel.mjs";
self.onmessage = async ({ data }) => {
  try { self.postMessage(await runDeadlineCases(data)); }
  catch (error) { self.postMessage({ status:"failed",fatal:String(error) }); }
};
