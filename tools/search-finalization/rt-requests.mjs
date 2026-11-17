/** Exact source is retained for the bounded child's independent read selection. */
export function rtDelayReads(record) {
  const finalization=record.format==="ptn-search-finalization"?record:record.format==="ptn-search-composition"?record.finalization:record.format==="ptn-search-pipeline"?record.composition?.finalization:null;
  if(!Array.isArray(finalization?.reads))throw new Error("RT replay requires a finalization observation");
  const reads=finalization.reads.filter(read=>read.kind==="delay").map(({tripId,value})=>({tripId,value}));
  if(!reads.length)throw new Error("No observed RT delay lookups");
  return reads;
}
