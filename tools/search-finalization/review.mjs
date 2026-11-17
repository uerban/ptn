import {writeFileSync} from "node:fs";
import {inspectFinalizationCapsule} from "./capsule.mjs";
import {capsuleInputContract} from "./diff.mjs";
import {fingerprint,canonical,createFrontendReviewBundle,createReviewComparison,validateReviewBundle} from "../search-review/contract.mjs";
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const signature=leg=>leg.type==="transit"?[leg.type,leg.tripId??null,leg.routeId??null,leg.fromStopId,leg.toStopId,leg.boardStopIdx??null,leg.alightStopIdx??null]:[leg.type,leg.fromStopId,leg.toStopId];
export async function buildCapsuleReviewBundle(store,id) {
  const snapshot=inspectFinalizationCapsule(store,id),{capsule,record}=snapshot;
  if(record.format!=="ptn-search-pipeline")throw new Error("Frontend review requires a complete linked pipeline observation");
  const input=record.composition.input,comparisonInputsSha256=await fingerprint(JSON.parse(JSON.stringify(capsuleInputContract(snapshot))));
  const settings={ranking:record.query.ranking,maxResults:input.maxResults,mobilityProfile:record.reach.entry.input.profile,walkSpeedMps:input.walkSpeedMps,minTransferSecs:input.minTransferSecs};
  const provenance={derivation:"retained-frontend-capsule-v1",artifacts:capsule.artifacts,runtime:capsule.replayRuntime,settings,comparisonInputsSha256,
    snapshotId:await fingerprint({artifacts:capsule.artifacts,runtime:capsule.replayRuntime,settings,comparisonInputsSha256}),runManifestSha256:snapshot.manifestSha256,
    classification:capsule.classification,replayVerification:capsule.replayVerification,recordProducerIdentity:capsule.recordProducerIdentity,
    missingDependencies:capsule.missingDependencies,unsupported:["original live application identity","human quality verdict","access/egress path geometry"]};
  const used=new Set([record.query.originStopId,record.query.destStopId,...(record.query.originStopIds??[]),...(record.query.destStopIds??[])]);
  for(const itinerary of record.output)for(const leg of itinerary.legs){used.add(leg.fromStopId);used.add(leg.toStopId);}
  const locations=new Map(input.stops.map(stop=>[stop.id,stop]));
  const context={derivation:"captured-frontend-context-v1",recordSha256:capsule.artifacts.record,departureSecs:input.departureSecs,
    serviceDate:record.planner?.serviceDate??record.timeFrame?.serviceDate??null,timeFrame:record.timeFrame??null,rtAssessmentNowMs:record.composition.finalization.nowMs,
    stops:[...locations.values()].filter(stop=>used.has(stop.id)).map(stop=>({id:stop.id,name:typeof stop.name==="string"?stop.name:"",lat:stop.lat,lon:stop.lon}))};
  const rows=record.output.map(itinerary=>{
    const matches=input.itineraries.filter(raw=>same(raw.legs.map(signature),itinerary.legs.map(signature)));
    const scheduled=matches.length===1?matches[0].legs.map((leg,index)=>({index,departSecs:leg.departSecs,arriveSecs:leg.arriveSecs})):null;
    const walkRoutes=itinerary.legs.flatMap((leg,index)=>{
      if(leg.type!=="walk")return [];
      const from=locations.get(leg.fromStopId),to=locations.get(leg.toStopId);
      const matching=from&&to?record.composition.reads.filter(read=>read.outcome==="route"&&read.route&&read.route.distanceMeters===leg.distanceMeters
        &&same(read.from,{lat:from.lat,lon:from.lon})&&same(read.to,{lat:to.lat,lon:to.lon})):[];
      return [{index,status:matching.length===1?"unique recorded response":"geometry not uniquely captured",route:matching.length===1?matching[0].route:null}];
    });
    return {itinerary,evidence:{scheduled,walkRoutes}};
  });
  const bundle=await createFrontendReviewBundle(provenance,record.query,context,rows);await validateReviewBundle(bundle);return bundle;
}
export async function exportCapsuleReview(store,id,destination) {
  const bundle=await buildCapsuleReviewBundle(store,id);writeBundle(bundle,destination);return bundle;
}
export async function exportCapsuleReviewComparison(beforeStore,beforeId,afterStore,afterId,destination) {
  const bundle=await createReviewComparison(await buildCapsuleReviewBundle(beforeStore,beforeId),await buildCapsuleReviewBundle(afterStore,afterId));writeBundle(bundle,destination);return bundle;
}
function writeBundle(bundle,path) {
  const bytes=JSON.stringify(bundle,null,2)+"\n";if(Buffer.byteLength(bytes)>10*1024*1024)throw new Error("Frontend review export exceeds the reviewer's 10 MiB limit");
  writeFileSync(path,bytes,{flag:"wx",mode:0o600});
}
