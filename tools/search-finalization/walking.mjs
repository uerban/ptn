/** Version-one walking request contract. No imports: the exact source is also
 * retained and executed from a data URL by the bounded replay child. */
export function walkingRequests(record,profile) {
  if(!["default","wheelchair"].includes(profile))throw new Error("Explicit walking profile required");
  const calls=[];
  let composition=record;
  if(record.format==="ptn-search-pipeline") {
    composition=record.composition;
    if(!record.directRoute)throw new Error("Ambiguous or unavailable direct walking observation is unsupported");
    const mobility=record.reach?.entry?.input?.profile;
    if(typeof mobility!=="string"||(mobility==="wheelchair"?"wheelchair":"default")!==profile)throw new Error("Walking profile differs from pipeline observation");
    calls.push({kind:"direct",index:0,from:record.query.origin,to:record.query.destination,route:record.directRoute});
  }else if(record.format!=="ptn-search-composition")throw new Error("Walking replay requires composition or pipeline observations");
  if(!Array.isArray(composition?.reads))throw new Error("Missing pedestrian observations");
  for(const [index,read] of composition.reads.entries()) {
    if(read.outcome!=="route")throw new Error("Unavailable pedestrian outcomes cannot be reproduced by a loaded graph");
    calls.push({kind:"transfer",index,from:read.from,to:read.to,route:read.route});
  }
  if(!calls.length)throw new Error("No observed pedestrian calls to replay");
  return calls;
}
