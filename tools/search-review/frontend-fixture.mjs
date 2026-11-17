// Synthetic test data only; no human judgments or retained live identities.
import {fingerprint,createFrontendReviewBundle} from "./contract.mjs";
export async function frontendFixture() {
 const artifacts=Object.fromEntries(["record","module","moduleBuild","replayChild"].map((key,index)=>[key,String(index+1).repeat(64)]));
 const runtime=Object.fromEntries(["node","v8","platform","arch","release","nodeExecutableSha256"].map(key=>[key,"fixture"]));
 const settings={maxResults:5},comparisonInputsSha256="a".repeat(64);
 const provenance={derivation:"retained-frontend-capsule-v1",artifacts,runtime,settings,comparisonInputsSha256,
  snapshotId:await fingerprint({artifacts,runtime,settings,comparisonInputsSha256}),runManifestSha256:"b".repeat(64),classification:"partial capture",replayVerification:"unverified",recordProducerIdentity:"synthetic test",missingDependencies:["fixture"],unsupported:["live identity"]};
 const route={coords:[[25,54],[25.001,54.001]],distanceMeters:184.2,steps:[{kind:"depart",name:'<img src="https://invalid.example/x">',distanceMeters:184.2,startIndex:0}]};
 const walk={legs:[],departureSecs:3600,arrivalSecs:3748,totalSecs:148,sourceWalkSecs:0,destWalkSecs:0,totalWalkSecs:148,totalWalkMeters:184.2,transfers:0,directWalk:{route}};
 const transit={legs:[{type:"transit",fromStopId:"A",toStopId:"B",routeShortName:"5",departSecs:3660,arriveSecs:3900}],departureSecs:3600,arrivalSecs:3920,totalSecs:320,sourceWalkSecs:10,destWalkSecs:20,totalWalkSecs:30,totalWalkMeters:38,transfers:0};
 const evidence={scheduled:null,walkRoutes:[]};
 return createFrontendReviewBundle(provenance,{departureTimeMs:1794556800000},{derivation:"captured-frontend-context-v1",recordSha256:artifacts.record,departureSecs:3600,serviceDate:"20261113",stops:[{id:"A",name:"Origin",lat:54,lon:25},{id:"B",name:"Destination",lat:54.001,lon:25.001}]},[{itinerary:walk,evidence},{itinerary:transit,evidence:{scheduled:[{index:0,departSecs:3650,arriveSecs:3890}],walkRoutes:[]}},{itinerary:walk,evidence}]);
}
