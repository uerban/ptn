import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync,cpSync,existsSync,statSync,renameSync,mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildFinalizationModule,sha,sourceRoot} from "../../../tools/search-finalization/module.mjs";
import {retainFinalization,replayFinalizationCapsule,attachPlannerReplay,attachWalkingReplay,attachRtReplay} from "../../../tools/search-finalization/capsule.mjs";
import {diffFinalizationCapsules} from "../../../tools/search-finalization/diff.mjs";
import {buildRtModule,rtCompilerInputName} from "../../../tools/search-finalization/rt-module.mjs";
import {retainArtifact} from "./baseline_store.mjs";
let root,moduleDir,recordPath,expected,compiled,moduleManifest;
before(async()=>{
 root=mkdtempSync(join(tmpdir(),"finalization-capsules-"));moduleDir=join(root,"module");
 const build=await buildFinalizationModule(moduleDir);moduleManifest=build;assert.ok(build.sources.length>1);
 const repeat=await buildFinalizationModule(join(root,"repeat-module"));assert.deepEqual(repeat,build);
 const bytes=readFileSync(join(moduleDir,"module.mjs"));assert.equal(sha(bytes),build.moduleSha256);
 const module=await import(`data:text/javascript;base64,${bytes.toString("base64")}`);compiled=module;
 const now=Date.now();let record;
 expected=module.finalizeSearch({composed:[{sourceWalkSecs:500,destWalkSecs:0,departureSecs:0,arrivalSecs:900,totalSecs:900,totalWalkSecs:500,totalWalkMeters:1214,transfers:0,
  legs:[{type:"transit",tripId:"T",routeId:"R",fromStopId:"A",toStopId:"B",departSecs:420,arriveSecs:900,boardStopIdx:0,alightStopIdx:1}]}],walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120},
  ()=>({delaySeconds:180,cancelled:false,receivedAt:now}),undefined,value=>{record=value;});
 assert.equal(expected.length,1);recordPath=join(root,"record.json");writeFileSync(recordPath,JSON.stringify(record));
});
after(()=>rmSync(root,{recursive:true,force:true}));
function fixture(name) {
 const store=join(root,name);const capsule=retainFinalization(store,"observed",recordPath,moduleDir);
 return {store,capsule};
}

test("retained code and record survive relocation, without build files or injected preloads",()=>{
 const {store}=fixture("relocation");const moved=join(root,"moved");cpSync(store,moved,{recursive:true});rmSync(store,{recursive:true});
 const hidden=join(root,"hidden-build");renameSync(moduleDir,hidden);
 const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS="--import=data:text/javascript,throw%20new%20Error('injected')";
 try {
  const output=join(root,"replayed"),proof=replayFinalizationCapsule(moved,"observed",output);
  assert.equal(proof.completion,"success");assert.deepEqual(proof.output,expected);
  assert.equal(statSync(output).mode&0o777,0o700);
  assert.equal(statSync(join(output,"verification.json")).mode&0o777,0o600);
  assert.throws(()=>replayFinalizationCapsule(moved,"observed",output),/EEXIST/);
 } finally {renameSync(hidden,moduleDir);if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
});

test("immutable capture does not overwrite an existing manifest",()=>{
 const {store}=fixture("no-overwrite"),path=join(store,"runs/observed.json"),original=readFileSync(path);
 assert.throws(()=>retainFinalization(store,"observed",recordPath,moduleDir),/EEXIST/);
 assert.deepEqual(readFileSync(path),original);
});

test("every declared artifact is verified before output materialization",()=>{
 const {store,capsule}=fixture("corruption");
 for(const [index,digest] of Object.values(capsule.artifacts).entries()) {
  const path=join(store,"artifacts",digest),original=readFileSync(path),destination=join(root,`corrupt-out-${index}`);
  writeFileSync(path,"corrupt");
  assert.throws(()=>replayFinalizationCapsule(store,"observed",destination),/integrity/);
  assert.equal(existsSync(destination),false);writeFileSync(path,original);
 }
});

test("missing artifacts and runtime/provenance mismatch fail before output",()=>{
 for(const kind of ["missing","runtime","provenance","producer"]) {
  const {store,capsule}=fixture(kind),out=join(root,`${kind}-out`);
  if(kind==="missing")rmSync(join(store,"artifacts",capsule.artifacts.module));
  if(kind==="producer") {capsule.recordProducerIdentity="verified";writeFileSync(join(store,"runs/observed.json"),JSON.stringify(capsule));}
  if(kind==="runtime") {capsule.replayRuntime.arch="different";writeFileSync(join(store,"runs/observed.json"),JSON.stringify(capsule));}
  if(kind==="provenance") {
   const build=JSON.parse(readFileSync(join(store,"artifacts",capsule.artifacts.moduleBuild)));build.moduleSha256="a".repeat(64);
   capsule.artifacts.moduleBuild=retainArtifact(store,Buffer.from(JSON.stringify(build)));writeFileSync(join(store,"runs/observed.json"),JSON.stringify(capsule));
  }
  assert.throws(()=>replayFinalizationCapsule(store,"observed",out));assert.equal(existsSync(out),false);
 }
});

function alternateModule(store,capsule,code) {
 const bytes=Buffer.from(code);capsule.artifacts.module=retainArtifact(store,bytes);
 const build=JSON.parse(readFileSync(join(store,"artifacts",capsule.artifacts.moduleBuild)));build.moduleSha256=sha(bytes);
 capsule.artifacts.moduleBuild=retainArtifact(store,Buffer.from(JSON.stringify(build)));
 writeFileSync(join(store,"runs/observed.json"),JSON.stringify(capsule));
}

test("timeout, module error and wrong replay output are outcomes, never empty success",()=>{
 for(const [kind,code] of [["timeout","export function replayFinalization(){while(true){}}"],["error","throw new Error('retained module failure')"],["wrong","export function replayFinalization(){return []}"]]) {
  const {store,capsule}=fixture(`outcome-${kind}`);alternateModule(store,capsule,code);
  const out=join(root,`outcome-${kind}-out`),proof=replayFinalizationCapsule(store,"observed",out,kind==="timeout"?100:5000);
  assert.equal(proof.completion,kind==="timeout"?"timeout":"error");assert.equal(proof.output,null);
  assert.ok(existsSync(join(out,"stdout.txt")));assert.ok(existsSync(join(out,"stderr.txt")));
  assert.equal(JSON.parse(readFileSync(join(out,"verification.json"))).completion,proof.completion);
 }
});

test("invalid run IDs, record size and module bytes do not create capsules",()=>{
 assert.throws(()=>retainFinalization(join(root,"invalid"),"../bad",recordPath,moduleDir),/run ID/);
 assert.equal(existsSync(join(root,"invalid")),false);
 const oversized=join(root,"oversized.json");writeFileSync(oversized,"x".repeat(2*1024*1024+1));
 assert.throws(()=>retainFinalization(join(root,"oversized"),"observed",oversized,moduleDir),/limit/);
 const altered=join(root,"altered-module");cpSync(moduleDir,altered,{recursive:true});
 // Copy retains read-only mode; replace this task-owned file explicitly.
 rmSync(join(altered,"module.mjs"));writeFileSync(join(altered,"module.mjs"),"throw new Error('must not execute during capture')");
 assert.throws(()=>retainFinalization(join(root,"altered"),"observed",recordPath,altered),/integrity/);
 assert.equal(existsSync(join(root,"altered")),false);
});

test("output buffer exhaustion discloses partial logs and cannot masquerade as success",()=>{
 const {store,capsule}=fixture("buffer-limit");
 alternateModule(store,capsule,"console.log('x'.repeat(5*1024*1024)); export function replayFinalization(){return []}");
 const out=join(root,"buffer-limit-out"),proof=replayFinalizationCapsule(store,"observed",out);
 assert.equal(proof.completion,"error");assert.equal(proof.logCaptureComplete,false);assert.equal(proof.output,null);
 assert.equal(proof.errorCode,"ENOBUFS");assert.ok(statSync(join(out,"stdout.txt")).size>0);
});

test("a valid empty finalization is a successful empty replay",()=>{
 let record;
 compiled.finalizeSearch({composed:[],walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120},()=>null,undefined,value=>{record=value;});
 record={...record,timeFrame:{kind:"timezone",timeZone:"UTC",departureUnix:0,departureSecs:0,timeOriginUnix:0,serviceDate:"19700101"}};
 const path=join(root,"empty-record.json"),store=join(root,"empty-store");writeFileSync(path,JSON.stringify(record));
 retainFinalization(store,"empty",path,moduleDir);
 const proof=replayFinalizationCapsule(store,"empty",join(root,"empty-replay"));
 assert.equal(proof.completion,"success");assert.deepEqual(proof.output,[]);assert.equal(proof.timeFrame,null);
});

test("capture never executes a coherently hashed supplied module",()=>{
 const directory=join(root,"no-implicit-execution");cpSync(moduleDir,directory,{recursive:true});
 const bytes=Buffer.from("throw new Error('explicit replay only')");
 rmSync(join(directory,"module.mjs"));writeFileSync(join(directory,"module.mjs"),bytes);
 const build=JSON.parse(readFileSync(join(directory,"manifest.json")));build.moduleSha256=sha(bytes);
 writeFileSync(join(directory,"manifest.json"),JSON.stringify(build));
 const store=join(root,"not-executed");retainFinalization(store,"observed",recordPath,directory);
 assert.ok(existsSync(join(store,"runs/observed.json")));
 const proof=replayFinalizationCapsule(store,"observed",join(root,"explicit-error"));
 assert.equal(proof.completion,"error");assert.equal(proof.output,null);
});

test("replay CLI works in an isolated toolkit without frontend/compiler dependencies",()=>{
 const {store}=fixture("isolated-cli-store"),stage=join(root,"isolated-toolkit");
 mkdirSync(join(stage,"tools"),{recursive:true});mkdirSync(join(stage,"crates/pt-wasm/tests"),{recursive:true});
 cpSync(join(sourceRoot,"tools/search-finalization"),join(stage,"tools/search-finalization"),{recursive:true});
 cpSync(join(sourceRoot,"crates/pt-wasm/tests/baseline_store.mjs"),join(stage,"crates/pt-wasm/tests/baseline_store.mjs"));
 const out=join(root,"isolated-cli-output");
 const child=spawnSync(process.execPath,[join(stage,"tools/search-finalization/cli.mjs"),"replay",store,"observed",out],{encoding:"utf8"});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout).output,expected);
 assert.equal(existsSync(join(stage,"packages/frontend/node_modules")),false);
});

test("post-planner walking composition retains raw planner output and replays routed evidence",async()=>{
 let record;
 const input={itineraries:[{boardSecs:100,alightSecs:900,transfers:1,legs:[
  {type:"transit",tripId:"T1",routeId:"R",fromStopId:"A",toStopId:"B",departSecs:100,arriveSecs:300,boardStopIdx:0,alightStopIdx:1},
  {type:"walk",fromStopId:"B",toStopId:"C",departSecs:300,arriveSecs:420},
  {type:"transit",tripId:"T2",routeId:"R",fromStopId:"C",toStopId:"D",departSecs:600,arriveSecs:900,boardStopIdx:0,alightStopIdx:1}]}],
  entryWalks:[{stopId:"A",walkSecs:0,distanceMeters:0}],exitWalks:[{stopId:"D",walkSecs:0,distanceMeters:0}],departureSecs:0,
  stops:[{id:"B",lat:54,lon:25},{id:"C",lat:54,lon:25.001}],walkSpeedMps:1.25,walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120};
 const output=await compiled.composeSearchResults(input,async()=>({coords:[[25,54],[25.001,54]],distanceMeters:400,steps:[]}),
  id=>id==="T2"?{delaySeconds:120,cancelled:false}:null,()=>120,value=>{record=value;});
 assert.equal(output.length,1);assert.equal(output[0].totalWalkMeters,400);
 assert.equal(record.input.itineraries[0].legs[1].arriveSecs,420);
 const path=join(root,"composition.json"),store=join(root,"composition-store");writeFileSync(path,JSON.stringify(record));
 const capsule=retainFinalization(store,"composition",path,moduleDir);
 assert.equal(capsule.scope,"frontend post-planner walking composition");
 const proof=replayFinalizationCapsule(store,"composition",join(root,"composition-output"));
 assert.equal(proof.completion,"success");assert.deepEqual(proof.output,output);
 const build=JSON.parse(readFileSync(join(store,"artifacts",capsule.artifacts.moduleBuild)));
 delete build.recordFormats;capsule.artifacts.moduleBuild=retainArtifact(store,Buffer.from(JSON.stringify(build)));
 writeFileSync(join(store,"runs/composition.json"),JSON.stringify(capsule));
 const refused=join(root,"unsupported-composition-output");
 assert.throws(()=>replayFinalizationCapsule(store,"composition",refused),/scope mismatch/);assert.equal(existsSync(refused),false);
});

test("module build uses workspace TS sources in a clean tree without shared dist",async()=>{
 assert.ok(moduleManifest.sources.some(row=>row.path==="packages/shared/src/constants/index.ts"));
 assert.equal(moduleManifest.sources.some(row=>row.path.includes("/dist/")),false);
 const tree=join(root,"source-only");
 mkdirSync(join(tree,"packages/frontend/src"),{recursive:true});mkdirSync(join(tree,"packages/shared"),{recursive:true});
 cpSync(join(sourceRoot,"packages/frontend/src/services"),join(tree,"packages/frontend/src/services"),{recursive:true});
 cpSync(join(sourceRoot,"packages/shared/src"),join(tree,"packages/shared/src"),{recursive:true});
 const clean=await buildFinalizationModule(join(root,"clean-module"),tree);
 assert.deepEqual(clean,moduleManifest);
 assert.equal(existsSync(join(tree,"packages/shared/dist")),false);
 assert.equal(existsSync(join(tree,"node_modules")),false);
});

test("directed reach capsules relocate and replay without clock or live providers",async()=>{
 let record;
 const origin={lat:54.68,lon:25.28},stops=[{id:"A",name:"A",...origin},{id:"B",name:"B",lat:54.681,lon:25.28}];
 const output=await compiled.captureReachableStops(origin,stops,{maxWalkSecs:300,walkSpeedMps:1.25,radiusMeters:500,role:"destination"},
  {isReady:()=>true,table:async(sources,destinations)=>{assert.deepEqual(destinations,[origin]);assert.equal(sources.length,2);return {durations:[[-1],[20]]};}},"default",value=>{record=value;});
 assert.deepEqual(output.map(row=>row.stopId),["B"]);
 assert.equal(Object.hasOwn(record,"nowMs"),false);
 const path=join(root,"reach.json"),store=join(root,"reach-store");writeFileSync(path,JSON.stringify(record));
 const capsule=retainFinalization(store,"reach",path,moduleDir);
 assert.equal(capsule.scope,"frontend directed endpoint reach");
 assert.ok(capsule.missingDependencies.includes("OSRM module/graph and transfer-table artifacts"));
 const moved=join(root,"reach-relocated");cpSync(store,moved,{recursive:true});rmSync(store,{recursive:true});
 const proof=replayFinalizationCapsule(moved,"reach",join(root,"reach-replayed"));
 assert.equal(proof.completion,"success");assert.equal(proof.scope,capsule.scope);assert.deepEqual(proof.output,output);
 assert.match(proof.recordProducerIdentity,/unverified/);
 const stage=join(root,"reach-isolated-toolkit");
 mkdirSync(join(stage,"tools"),{recursive:true});mkdirSync(join(stage,"crates/pt-wasm/tests"),{recursive:true});
 cpSync(join(sourceRoot,"tools/search-finalization"),join(stage,"tools/search-finalization"),{recursive:true});
 cpSync(join(sourceRoot,"crates/pt-wasm/tests/baseline_store.mjs"),join(stage,"crates/pt-wasm/tests/baseline_store.mjs"));
 const isolated=spawnSync(process.execPath,[join(stage,"tools/search-finalization/cli.mjs"),"replay",moved,"reach",join(root,"reach-isolated-output")],{encoding:"utf8"});
 assert.equal(isolated.status,0,isolated.stderr);assert.deepEqual(JSON.parse(isolated.stdout).output,output);
 assert.equal(existsSync(join(stage,"packages")),false);
 const mismatched={...record,scope:"frontend RT feasibility and ranking"};writeFileSync(path,JSON.stringify(mismatched));
 const refused=join(root,"reach-wrong-scope");assert.throws(()=>retainFinalization(refused,"reach",path,moduleDir),/Unsupported/);assert.equal(existsSync(refused),false);
 // A module manifest must explicitly support reach, never infer it from an older module.
 const build=JSON.parse(readFileSync(join(moved,"artifacts",capsule.artifacts.moduleBuild)));delete build.recordFormats;
 capsule.artifacts.moduleBuild=retainArtifact(moved,Buffer.from(JSON.stringify(build)));writeFileSync(join(moved,"runs/reach.json"),JSON.stringify(capsule));
 const unsupported=join(root,"reach-legacy-module");assert.throws(()=>replayFinalizationCapsule(moved,"reach",unsupported),/scope mismatch/);assert.equal(existsSync(unsupported),false);
});

test("linked stage capsule replays and rejects an individually valid but disconnected planner query",async()=>{
 const origin={lat:54.68,lon:25.28},destination={lat:54.70,lon:25.28};
 const stops=[{id:"A",name:"A",...origin},{id:"B",name:"B",...destination}];
 const options={maxWalkSecs:300,walkSpeedMps:1.25,radiusMeters:500},reach={};
 const osrm={isReady:()=>false,table:async()=>null};
 const entry=await compiled.captureReachableStops(origin,stops,{...options,role:"origin"},osrm,"default",r=>{reach.entry=r;});
 const exit=await compiled.captureReachableStops(destination,stops,{...options,role:"destination"},osrm,"default",r=>{reach.exit=r;});
 const raw=[{boardSecs:28850,alightSecs:29000,transfers:0,legs:[{type:"transit",tripId:"T",routeId:"R",fromStopId:"A",toStopId:"B",departSecs:28850,arriveSecs:29000,boardStopIdx:0,alightStopIdx:1}]}];
 let composition;
 const output=await compiled.composeSearchResults({itineraries:raw,entryWalks:entry,exitWalks:exit,departureSecs:28800,stops,walkSpeedMps:1.25,
  walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120},undefined,()=>null,undefined,r=>{composition=r;});
 assert.equal(output.length,1);
 const record={format:"ptn-search-pipeline",version:1,scope:"frontend linked stages with observed planner",classification:"partial capture",normalization:"finite-json-wire-v1",
  query:{origin,destination,departureTimeMs:Date.parse("2026-11-13T08:00:00+02:00"),ranking:"fastest"},reach,directRoute:null,
  planner:{source:"injected",serviceDate:"20261113",query:{entryStops:entry.map(({stopId,walkSecs})=>({stopId,walkSecs})),exitStops:exit.map(({stopId,walkSecs})=>({stopId,walkSecs})),
   departureSecs:28800,activeServiceIds:["svc"],walkSpeedMps:1.25,minTransferSecs:120},output:raw},composition,output,missingDependencies:["observed fixture planner; execution artifacts absent"]};
 const path=join(root,"pipeline.json"),store=join(root,"pipeline-store");writeFileSync(path,JSON.stringify(record));
 const capsule=retainFinalization(store,"linked",path,moduleDir);assert.equal(capsule.scope,record.scope);
 const proof=replayFinalizationCapsule(store,"linked",join(root,"pipeline-replay"));assert.equal(proof.completion,"success");assert.deepEqual(proof.output,output);
 const {exportCapsuleReview}=await import("../../../tools/search-finalization/review.mjs");
 const reviewDestination=join(root,"frontend-review.json"),review=await exportCapsuleReview(store,"linked",reviewDestination);
 assert.deepEqual(review.cases[0].candidates.map(candidate=>candidate.itinerary),output);
 assert.equal(statSync(reviewDestination).mode&0o777,0o600);
 assert.equal(JSON.stringify(review).includes(root),false);
 await assert.rejects(exportCapsuleReview(store,"linked",reviewDestination),/EEXIST/);
 const {store:standalone}=fixture("review-standalone");
 await assert.rejects(exportCapsuleReview(standalone,"observed",join(root,"invalid-review.json")),/linked pipeline/);

 record.planner.query.entryStops[0].walkSecs++;
 writeFileSync(path,JSON.stringify(record));retainFinalization(store,"disconnected",path,moduleDir);
 const failed=replayFinalizationCapsule(store,"disconnected",join(root,"pipeline-disconnected-replay"));
 assert.equal(failed.completion,"error");assert.equal(failed.output,null);
 assert.match(readFileSync(join(root,"pipeline-disconnected-replay/stderr.txt"),"utf8"),/planner entry/);
});

test("supplied planner artifacts execute only on replay and preserve source observations",()=>{
 const store=join(root,"pipeline-store"),sourcePath=join(store,"runs/linked.json"),sourceBytes=readFileSync(sourcePath);
 const source=JSON.parse(sourceBytes),record=JSON.parse(readFileSync(join(store,"artifacts",source.artifacts.record)));
 const glue=join(root,"planner-glue.mjs"),wasm=join(root,"planner.wasm"),ptb=join(root,"planner.ptb"),transfers=join(root,"planner.transfers");
 writeFileSync(wasm,"wasm");writeFileSync(ptb,"ptb");writeFileSync(transfers,"transfers");
 const artifactOptions={glue,wasm,ptb,transfers,patternMode:"covering-merge"};
 const prefix=`export function initSync({module}){if(module.toString()!=="wasm")throw new Error("WASM bytes changed")}export class PtRouter{constructor(bytes,mode){if(bytes.toString()!=="ptb"||mode!=="covering-merge")throw new Error("state mismatch")}setTransfers(bytes){if(bytes.toString()!=="transfers")throw new Error("transfer bytes changed");this.set=true}free(){}`;
 const successful=prefix+`plan(query){if(!this.set)throw new Error("missing transfers");if(query.date!=="20261113"||query.departureSecs!==28800||query.entryStops[0].walkSecs!==0||"activeServiceIds" in query)throw new Error("query mapping changed");return ${JSON.stringify(record.planner.output)}}}`;
 writeFileSync(glue,successful);
 const attached=attachPlannerReplay(store,"linked","with-engine",artifactOptions);
 assert.deepEqual(readFileSync(sourcePath),sourceBytes);assert.equal(attached.replayVerification,"unverified");
 const moved=join(root,"attached-planner-moved");cpSync(store,moved,{recursive:true});
 const proof=replayFinalizationCapsule(moved,"with-engine",join(root,"attached-planner-replay"));
 assert.equal(proof.completion,"success",readFileSync(join(root,"attached-planner-replay/stderr.txt"),"utf8"));assert.deepEqual(proof.output,record.output);assert.deepEqual(proof.planner.output,record.planner.output);
 assert.equal(proof.planner.query.date,"20261113");assert.equal(proof.planner.patternMode,"covering-merge");assert.equal(Object.hasOwn(proof.planner.query,"activeServiceIds"),false);
 assert.match(proof.plannerExecution.originalHandleIdentity,/unverified/);
 assert.throws(()=>attachPlannerReplay(store,"linked","with-engine",artifactOptions),/EEXIST/);
 assert.throws(()=>attachPlannerReplay(store,"with-engine","reattach",artifactOptions),/unattached/);
 for(const [name,hash] of Object.entries(attached.artifacts).filter(([name])=>name.startsWith("planner"))) {
  const path=join(store,"artifacts",hash),original=readFileSync(path);writeFileSync(path,"corrupt");
  const destination=join(root,`planner-corrupt-${name}`);assert.throws(()=>replayFinalizationCapsule(store,"with-engine",destination),/integrity/);assert.equal(existsSync(destination),false);writeFileSync(path,original);
 }
 for(const [name,code] of [["wrong",prefix+"plan(){return []}}"],["throw","throw new Error('no implicit execution')"],["timeout",prefix+"plan(){while(true){}}}"]]) {
  writeFileSync(glue,code);attachPlannerReplay(store,"linked",`engine-${name}`,artifactOptions);
  const failed=replayFinalizationCapsule(store,`engine-${name}`,join(root,`engine-${name}-out`),name==="timeout"?150:5000);
  assert.equal(failed.completion,name==="timeout"?"timeout":"error");assert.equal(failed.output,null);assert.equal(failed.planner,null);
 }
 writeFileSync(glue,prefix+`plan(){if(this.set)throw new Error("unexpected transfers");return ${JSON.stringify(record.planner.output)}}}`);
 attachPlannerReplay(store,"linked","engine-no-transfers",{...artifactOptions,transfers:null});
 const none=replayFinalizationCapsule(store,"engine-no-transfers",join(root,"engine-none-out"));assert.equal(none.completion,"success");assert.equal(Object.hasOwn(none.planner.artifacts,"plannerTransfers"),false);
 assert.throws(()=>attachPlannerReplay(store,"linked","implicit-transfers",{...artifactOptions,transfers:undefined}),/Explicit/);
 assert.throws(()=>attachPlannerReplay(store,"linked","invalid-pattern",{...artifactOptions,patternMode:"default"}),/Explicit/);
 const ignored=JSON.parse(readFileSync(join(store,"runs/with-engine.json")));
 ignored.artifacts.replayChild=retainArtifact(store,Buffer.from('import {readFileSync} from "node:fs";process.stdout.write(JSON.stringify({completion:"success",moduleHash:process.argv[3],recordHash:process.argv[4],output:JSON.parse(readFileSync(process.argv[2])).output}));'));
 writeFileSync(join(store,"runs/ignored-planner.json"),JSON.stringify(ignored));
 const unproved=replayFinalizationCapsule(store,"ignored-planner",join(root,"ignored-planner-proof"));assert.equal(unproved.completion,"error");assert.equal(unproved.output,null);
 const manifest=JSON.parse(readFileSync(join(store,"runs/with-engine.json")));manifest.plannerExecution.originalHandleIdentity="verified";writeFileSync(join(store,"runs/with-engine.json"),JSON.stringify(manifest));
 const refused=join(root,"planner-identity-upgrade");assert.throws(()=>replayFinalizationCapsule(store,"with-engine",refused),/Unsupported planner/);assert.equal(existsSync(refused),false);
});

test("supplied walking graph verifies recorded route calls, with bounded failures and immutable provenance",async()=>{
 const route={coords:[[25,54],[25.001,54]],distanceMeters:400,steps:[]};
 const input={itineraries:[{boardSecs:100,alightSecs:900,transfers:1,legs:[
  {type:"transit",tripId:"T1",routeId:"R",fromStopId:"A",toStopId:"B",departSecs:100,arriveSecs:300,boardStopIdx:0,alightStopIdx:1},
  {type:"walk",fromStopId:"B",toStopId:"C",departSecs:300,arriveSecs:420},
  {type:"transit",tripId:"T2",routeId:"R",fromStopId:"C",toStopId:"D",departSecs:600,arriveSecs:900,boardStopIdx:0,alightStopIdx:1}]}],
  entryWalks:[{stopId:"A",walkSecs:0,distanceMeters:0}],exitWalks:[{stopId:"D",walkSecs:0,distanceMeters:0}],departureSecs:0,
  stops:[{id:"B",lat:54,lon:25},{id:"C",lat:54,lon:25.001}],walkSpeedMps:1.25,walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120};
 let record;const output=await compiled.composeSearchResults(input,async()=>route,()=>null,()=>120,r=>{record=r;});
 const path=join(root,"walking-observed.json"),store=join(root,"walking-store");writeFileSync(path,JSON.stringify(record));
 retainFinalization(store,"original",path,moduleDir);const sourcePath=join(store,"runs/original.json"),original=readFileSync(sourcePath);
 const glue=join(root,"walking-glue.mjs"),wasm=join(root,"walking.wasm"),graph=join(root,"walking.ptwg");
 writeFileSync(wasm,"walk-wasm");writeFileSync(graph,"walk-graph");
 const code=(body,city="vilnius")=>[
  'export function initSync({module}){if(module.toString()!=="walk-wasm")throw new Error("WASM state mismatch")}',
  'export class PtWalkGraph {',
  'constructor(bytes){if(bytes.toString()!=="walk-graph")throw new Error("graph state mismatch")}',
  `cityId(){return ${JSON.stringify(city)};}`, 'free(){}', `route(lat,lon,toLat,toLon,profile){if(lat!==54||lon!==25||toLat!==54||toLon!==25.001||profile!=="default")throw new Error("walking query changed");${body}}`, '}'].join("\n");
 writeFileSync(glue,code(`return ${JSON.stringify(route)};`));const options={glue,wasm,graph,cityId:"vilnius",profile:"default"};
 const attached=attachWalkingReplay(store,"original","walking",options);assert.deepEqual(readFileSync(sourcePath),original);
 assert.equal(attached.replayVerification,"unverified");assert.match(attached.walkingExecution.originalGraphIdentity,/unverified/);
 const moved=join(root,"walking-relocated");cpSync(store,moved,{recursive:true});
 const proof=replayFinalizationCapsule(moved,"walking",join(root,"walking-proof"));assert.equal(proof.completion,"success",readFileSync(join(root,"walking-proof/stderr.txt"),"utf8"));
 assert.deepEqual(proof.output,output);assert.deepEqual(proof.walking.calls,[{kind:"transfer",index:0,from:{lat:54,lon:25},to:{lat:54,lon:25.001},route}]);
 assert.throws(()=>attachWalkingReplay(store,"original","walking",options),/EEXIST/);
 assert.throws(()=>attachWalkingReplay(store,"walking","again",options),/already attached/);
 for(const [name,hash] of Object.entries(attached.artifacts).filter(([name])=>name.startsWith("walking"))) {
  const path=join(store,"artifacts",hash),saved=readFileSync(path);writeFileSync(path,"corrupt");const out=join(root,`walking-corrupt-${name}`);
  assert.throws(()=>replayFinalizationCapsule(store,"walking",out),/integrity/);assert.equal(existsSync(out),false);writeFileSync(path,saved);
 }
 for(const [id,source,completion] of [["wrong-route",code("return null;"),"error"],["wrong-city",code(`return ${JSON.stringify(route)};`,"elsewhere"),"error"],["throw","throw new Error('explicit replay only')","error"],["timeout",code("while(true){}"),"timeout"]]) {
  writeFileSync(glue,source);attachWalkingReplay(store,"original",id,options);
  const failure=replayFinalizationCapsule(store,id,join(root,`walking-${id}`),id==="timeout"?150:5000);assert.equal(failure.completion,completion);assert.equal(failure.output,null);assert.equal(failure.walking,null);
 }
 assert.throws(()=>attachWalkingReplay(join(root,"pipeline-store"),"linked","ambiguous-direct",options),/Ambiguous/);
 const unproved=JSON.parse(readFileSync(join(store,"runs/walking.json")));unproved.artifacts.replayChild=retainArtifact(store,Buffer.from('import {readFileSync} from "node:fs";process.stdout.write(JSON.stringify({completion:"success",moduleHash:process.argv[3],recordHash:process.argv[4],output:JSON.parse(readFileSync(process.argv[2])).output}));'));
 writeFileSync(join(store,"runs/walking-unproved.json"),JSON.stringify(unproved));const denied=replayFinalizationCapsule(store,"walking-unproved",join(root,"walking-unproved"));assert.equal(denied.completion,"error");
 const unsupported=JSON.parse(readFileSync(join(store,"artifacts",attached.artifacts.record)));
 unsupported.reads[0]={from:{lat:54,lon:25},to:{lat:54,lon:25.001},outcome:"unavailable",cityId:"vilnius",reason:"transient"};
 writeFileSync(path,JSON.stringify(unsupported));retainFinalization(store,"unavailable",path,moduleDir);
 assert.throws(()=>attachWalkingReplay(store,"unavailable","not-a-null-route",options),/Unavailable/);
 let noCalls;
 await compiled.composeSearchResults({...input,itineraries:[]},undefined,()=>null,undefined,r=>{noCalls=r;});
 writeFileSync(path,JSON.stringify(noCalls));retainFinalization(store,"no-calls",path,moduleDir);
 assert.throws(()=>attachWalkingReplay(store,"no-calls","not-a-graph-execution",options),/No observed/);
 const nullOutput=await compiled.composeSearchResults(input,async()=>null,()=>null,()=>120,r=>{record=r;});
 writeFileSync(path,JSON.stringify(record));retainFinalization(store,"null-observation",path,moduleDir);
 writeFileSync(glue,code("return null;"));attachWalkingReplay(store,"null-observation","null-replay",options);
 const nullProof=replayFinalizationCapsule(store,"null-replay",join(root,"walking-null-proof"));assert.equal(nullProof.completion,"success");assert.deepEqual(nullProof.output,nullOutput);assert.equal(nullProof.walking.calls[0].route,null);
});

test("planner and walking attachments compose in either order with independent WASM instances",async()=>{
 const source=JSON.parse(readFileSync(join(root,"pipeline-store/runs/linked.json")));
 const record=JSON.parse(readFileSync(join(root,"pipeline-store/artifacts",source.artifacts.record)));
 const route={coords:[[25.28,54.68],[25.28,54.70]],distanceMeters:400,steps:[]};record.directRoute=route;
 const start=record.composition.input.departureSecs;
 const walking={directWalk:{origin:record.query.origin,destination:record.query.destination,route},legs:[],sourceWalkSecs:0,destWalkSecs:0,
  departureSecs:start,arrivalSecs:start+320,totalSecs:320,totalWalkSecs:320,totalWalkMeters:400,transfers:0};
 record.output=await compiled.composeSearchResults({...record.composition.input,walking},async()=>route,()=>null,undefined,r=>{record.composition=r;});
 const path=join(root,"combined-record.json"),store=join(root,"combined-store");writeFileSync(path,JSON.stringify(record));retainFinalization(store,"source",path,moduleDir);
 const glue=join(root,"combined-glue.mjs"),plannerWasm=join(root,"combined-planner.wasm"),walkingWasm=join(root,"combined-walking.wasm"),ptb=join(root,"combined.ptb"),graph=join(root,"combined.ptwg");
 writeFileSync(plannerWasm,"planner");writeFileSync(walkingWasm,"walking");writeFileSync(ptb,"ptb");writeFileSync(graph,"graph");
 writeFileSync(glue,[
  'let tag;export function initSync({module}){tag??=module.toString()}',
  `export class PtRouter{free(){}plan(){if(tag!=="planner")throw new Error("planner module instance changed");return ${JSON.stringify(record.planner.output)};}}`,
  `export class PtWalkGraph{free(){}cityId(){return "vilnius"}route(){if(tag!=="walking")throw new Error("walking module instance changed");return ${JSON.stringify(route)};}}`].join("\n"));
 const planner={glue,wasm:plannerWasm,ptb,transfers:null,patternMode:"covering-merge"},walk={glue,wasm:walkingWasm,graph,cityId:"vilnius",profile:"default"};
 attachPlannerReplay(store,"source","planner-first",planner);attachWalkingReplay(store,"planner-first","both-planner-first",walk);
 attachWalkingReplay(store,"source","walking-first",walk);attachPlannerReplay(store,"walking-first","both-walking-first",planner);
 for(const id of ["both-planner-first","both-walking-first"]) {
  const out=join(root,id),proof=replayFinalizationCapsule(store,id,out);
  assert.equal(proof.completion,"success",readFileSync(join(out,"stderr.txt"),"utf8"));assert.deepEqual(proof.output,record.output);
  assert.deepEqual(proof.planner.output,record.planner.output);assert.equal(proof.walking.calls.length,1);assert.equal(proof.walking.calls[0].kind,"direct");
 }
 assert.throws(()=>attachWalkingReplay(store,"source","wrong-profile",{...walk,profile:"wheelchair"}),/profile differs/);
 const altered=JSON.parse(readFileSync(join(store,"runs/walking-first.json")));altered.walkingExecution.originalGraphIdentity="verified";writeFileSync(join(store,"runs/claimed-graph.json"),JSON.stringify(altered));
 const denied=join(root,"claimed-graph-proof");assert.throws(()=>replayFinalizationCapsule(store,"claimed-graph",denied),/Unsupported walking/);assert.equal(existsSync(denied),false);
});

test("time frame capability binds captured clock and supplied engine resolveTime",()=>{
 const source=JSON.parse(readFileSync(join(root,"pipeline-store/runs/linked.json")));
 const record=JSON.parse(readFileSync(join(root,"pipeline-store/artifacts",source.artifacts.record)));
 const unix=record.query.departureTimeMs/1000;
 record.timeFrame={kind:"engine",departureUnix:unix,serviceDate:record.planner.serviceDate,departureSecs:record.planner.query.departureSecs,timeOriginUnix:unix-record.planner.query.departureSecs};
 record.planner.source="on-device";
 const path=join(root,"clock-record.json"),store=join(root,"clock-store");writeFileSync(path,JSON.stringify(record));
 const legacy=join(root,"module-no-clock-support");cpSync(moduleDir,legacy,{recursive:true});
 const manifest=JSON.parse(readFileSync(join(legacy,"manifest.json")));delete manifest.timeFrameReplay;writeFileSync(join(legacy,"manifest.json"),JSON.stringify(manifest));
 const refused=join(root,"unsupported-clock-store");assert.throws(()=>retainFinalization(refused,"clock",path,legacy),/time frame/);assert.equal(existsSync(refused),false);
 retainFinalization(store,"clock",path,moduleDir);
 const frozen=replayFinalizationCapsule(store,"clock",join(root,"clock-observed-replay"));assert.equal(frozen.completion,"success");assert.match(frozen.timeFrame.verification,/arithmetic/);
 const glue=join(root,"clock-glue.mjs"),wasm=join(root,"clock.wasm"),ptb=join(root,"clock.ptb");writeFileSync(wasm,"wasm");writeFileSync(ptb,"ptb");
 const resolved={serviceDate:record.timeFrame.serviceDate,departureSecs:record.timeFrame.departureSecs,timeOriginUnix:record.timeFrame.timeOriginUnix};
 const code=value=>['export function initSync(){}','export class PtRouter {','free(){}',`resolveTime(unix){if(unix!==${unix})throw new Error("clock argument changed");return ${JSON.stringify(value)};}`,`plan(){return ${JSON.stringify(record.planner.output)};}`,'}'].join("\n");
 writeFileSync(glue,code(resolved));const options={glue,wasm,ptb,transfers:null,patternMode:"covering-merge"};attachPlannerReplay(store,"clock","clock-with-engine",options);
 const proof=replayFinalizationCapsule(store,"clock-with-engine",join(root,"clock-engine-replay"));assert.equal(proof.completion,"success");assert.deepEqual(proof.planner.timeFrame,record.timeFrame);assert.match(proof.timeFrame.verification,/re-executed/);
 writeFileSync(glue,code({...resolved,timeOriginUnix:resolved.timeOriginUnix+3600}));attachPlannerReplay(store,"clock","clock-wrong-engine",options);
 const wrong=replayFinalizationCapsule(store,"clock-wrong-engine",join(root,"clock-wrong-engine-replay"));assert.equal(wrong.completion,"error");assert.equal(wrong.output,null);
 assert.match(readFileSync(join(root,"clock-wrong-engine-replay/stderr.txt"),"utf8"),/Engine time frame/);
 record.query.departureTimeMs+=3600000;writeFileSync(path,JSON.stringify(record));retainFinalization(store,"clock-altered",path,moduleDir);
 const altered=replayFinalizationCapsule(store,"clock-altered",join(root,"clock-altered-replay"));assert.equal(altered.completion,"error");assert.equal(altered.output,null);
});

test("RT compiler dependency provenance is independent of pnpm store placement",()=>{
 const checkout=join(root,"checkout"),internal=join(checkout,"node_modules/.pnpm"),external=join(root,"external-store");
 assert.equal(rtCompilerInputName(checkout,internal,join(internal,"protobufjs@1/node_modules/protobufjs/light.js")),"dependencies/protobufjs@1/node_modules/protobufjs/light.js");
 assert.equal(rtCompilerInputName(checkout,external,join(external,"protobufjs@1/node_modules/protobufjs/light.js")),"dependencies/protobufjs@1/node_modules/protobufjs/light.js");
 assert.equal(rtCompilerInputName(checkout,internal,join(checkout,"packages/shared/src/proto/route-update.ts")),"packages/shared/src/proto/route-update.ts");
 assert.equal(rtCompilerInputName(checkout,internal,join(root,"unrelated/private.json")),null);
});

test("frontend binary RT history replays decoding/store lookup without runtime packages",async()=>{
 const module=join(root,"rt-module"),build=await buildRtModule(module),repeat=await buildRtModule(join(root,"rt-module-repeat"));assert.deepEqual(build,repeat);
 assert.ok(build.sources.some(row=>row.path.startsWith("dependencies/")));assert.ok(build.sources.some(row=>row.path==="virtual/browser-fs.js"));
 const envelope=join(root,"rt-wire.bin");writeFileSync(envelope,Buffer.from("0a0152120a0a015410f001180020001801","hex"));
 const receivedAt=Date.now();let record;
 compiled.finalizeSearch({composed:[{sourceWalkSecs:0,destWalkSecs:0,departureSecs:0,arrivalSecs:900,totalSecs:900,totalWalkSecs:0,totalWalkMeters:0,transfers:0,
  legs:[{type:"transit",tripId:"T",routeId:"R",fromStopId:"A",toStopId:"B",departSecs:420,arriveSecs:900,boardStopIdx:0,alightStopIdx:1}]}],walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120},
  ()=>({delaySeconds:120,cancelled:false,deleted:false,receivedAt}),undefined,r=>{record=r;});assert.equal(record.output.length,1);
 const path=join(root,"rt-observed.json"),store=join(root,"rt-store"),events=join(root,"rt-events.json");writeFileSync(path,JSON.stringify(record));writeFileSync(events,JSON.stringify([{kind:"update",path:"rt-wire.bin",receivedAt}]));
 retainFinalization(store,"observed",path,moduleDir);const original=readFileSync(join(store,"runs/observed.json"));
 const attached=attachRtReplay(store,"observed","with-rt",{moduleDirectory:module,eventsPath:events});assert.deepEqual(readFileSync(join(store,"runs/observed.json")),original);
 const moved=join(root,"rt-relocated");cpSync(store,moved,{recursive:true});
 const proof=replayFinalizationCapsule(moved,"with-rt",join(root,"rt-replayed"));assert.equal(proof.completion,"success",readFileSync(join(root,"rt-replayed/stderr.txt"),"utf8"));assert.deepEqual(proof.output,record.output);assert.ok(proof.rt.reads.length>0);assert.equal(proof.rt.reads[0].value.delaySeconds,120);assert.match(proof.rtExecution.originalRtIdentity,/unverified/);
 assert.throws(()=>attachRtReplay(store,"observed","with-rt",{moduleDirectory:module,eventsPath:events}),/EEXIST/);
 assert.throws(()=>attachRtReplay(store,"with-rt","again",{moduleDirectory:module,eventsPath:events}),/already attached/);
 const stage=join(root,"rt-isolated-toolkit");mkdirSync(join(stage,"tools"),{recursive:true});mkdirSync(join(stage,"crates/pt-wasm/tests"),{recursive:true});
 cpSync(join(sourceRoot,"tools/search-finalization"),join(stage,"tools/search-finalization"),{recursive:true});cpSync(join(sourceRoot,"crates/pt-wasm/tests/baseline_store.mjs"),join(stage,"crates/pt-wasm/tests/baseline_store.mjs"));
 const isolated=spawnSync(process.execPath,[join(stage,"tools/search-finalization/cli.mjs"),"replay",moved,"with-rt",join(root,"rt-isolated-out")],{encoding:"utf8"});assert.equal(isolated.status,0,isolated.stderr);assert.deepEqual(JSON.parse(isolated.stdout).output,record.output);assert.equal(existsSync(join(stage,"packages")),false);
 for(const [name,hash] of Object.entries(attached.artifacts).filter(([name])=>name.startsWith("rt"))) {
  const file=join(store,"artifacts",hash),saved=readFileSync(file);writeFileSync(file,"corrupt");const out=join(root,`rt-corrupt-${name}`);assert.throws(()=>replayFinalizationCapsule(store,"with-rt",out),/integrity/);assert.equal(existsSync(out),false);writeFileSync(file,saved);
 }
 const prior=readFileSync(envelope);writeFileSync(envelope,Buffer.from("12ff","hex"));attachRtReplay(store,"observed","malformed",{moduleDirectory:module,eventsPath:events});
 const bad=replayFinalizationCapsule(store,"malformed",join(root,"rt-malformed-out"));assert.equal(bad.completion,"error");assert.equal(bad.output,null);assert.equal(bad.rt,null);
 writeFileSync(envelope,prior);writeFileSync(events,JSON.stringify([{kind:"update",path:"rt-wire.bin",receivedAt:receivedAt-1}]));attachRtReplay(store,"observed","wrong-receipt",{moduleDirectory:module,eventsPath:events});
 const wrong=replayFinalizationCapsule(store,"wrong-receipt",join(root,"rt-wrong-receipt"));assert.equal(wrong.completion,"error");assert.equal(wrong.output,null);
 for(const [id,code] of [["decoder-throws","throw new Error('explicit decoder replay only')"],["decoder-timeout","export function replayRtEnvelopes(){while(true){}}"]]) {
  const alternate=join(root,id);cpSync(module,alternate,{recursive:true});rmSync(join(alternate,"module.mjs"));const bytes=Buffer.from(code);writeFileSync(join(alternate,"module.mjs"),bytes);
  const build=JSON.parse(readFileSync(join(alternate,"manifest.json")));build.moduleSha256=sha(bytes);writeFileSync(join(alternate,"manifest.json"),JSON.stringify(build));
  attachRtReplay(store,"observed",id,{moduleDirectory:alternate,eventsPath:events});
  const failed=replayFinalizationCapsule(store,id,join(root,id+"-out"),id==="decoder-timeout"?150:5000);assert.equal(failed.completion,id==="decoder-timeout"?"timeout":"error");assert.equal(failed.output,null);assert.equal(failed.rt,null);
 }
 const unproved=JSON.parse(readFileSync(join(store,"runs/with-rt.json")));unproved.artifacts.replayChild=retainArtifact(store,Buffer.from('import {readFileSync} from "node:fs";process.stdout.write(JSON.stringify({completion:"success",moduleHash:process.argv[3],recordHash:process.argv[4],output:JSON.parse(readFileSync(process.argv[2])).output}));'));
 writeFileSync(join(store,"runs/rt-unproved.json"),JSON.stringify(unproved));assert.equal(replayFinalizationCapsule(store,"rt-unproved",join(root,"rt-unproved-out")).completion,"error");
 const claimed=JSON.parse(readFileSync(join(store,"runs/with-rt.json")));claimed.rtExecution.originalRtIdentity="verified";writeFileSync(join(store,"runs/claimed.json"),JSON.stringify(claimed));const denied=join(root,"rt-claimed-out");assert.throws(()=>replayFinalizationCapsule(store,"claimed",denied),/Unsupported RT/);assert.equal(existsSync(denied),false);
});

test("frontend capsule diff keeps complete fields, duplicate counts, order and confounded inputs visible without execution",()=>{
 const store=join(root,"diff-store"),base=JSON.parse(readFileSync(recordPath)),file=join(root,"diff-record.json");
 const capture=(id,value)=>{writeFileSync(file,JSON.stringify(value));return retainFinalization(store,id,file,moduleDir);};
 const before=capture("before",base),bytes=readFileSync(join(store,"runs/before.json"));capture("same",base);
 let diff=diffFinalizationCapsules(store,"before",store,"same");assert.equal(diff.status,"unchanged");assert.equal(diff.qualityVerdict,null);assert.equal(diff.replayVerification,"not evaluated by diff");
 const changed=structuredClone(base);changed.output[0].arrivalSecs++;changed.output[0].unknownField={stillVisible:true};capture("changed",changed);
 diff=diffFinalizationCapsules(store,"before",store,"changed");assert.equal(diff.status,"changed/unreviewed");assert.ok(diff.fieldChanges.some(row=>row.path.includes("unknownField")));assert.equal(diff.added.length,1);assert.equal(diff.removed.length,1);
 const duplicate=structuredClone(base);duplicate.output.push(structuredClone(base.output[0]));capture("duplicates",duplicate);
 diff=diffFinalizationCapsules(store,"before",store,"duplicates");assert.equal(diff.added.length,1);assert.equal(diff.removed.length,0);
 const ordered=structuredClone(changed);ordered.output=[base.output[0],changed.output[0]];capture("order-a",ordered);ordered.output.reverse();capture("order-b",ordered);
 diff=diffFinalizationCapsules(store,"order-a",store,"order-b");assert.equal(diff.status,"changed/unreviewed");assert.equal(diff.orderingOnly,true);assert.equal(diff.added.length,0);assert.equal(diff.removed.length,0);
 const clock=structuredClone(changed);clock.nowMs++;capture("other-clock",clock);
 diff=diffFinalizationCapsules(store,"before",store,"other-clock");assert.equal(diff.status,"incomparable");assert.ok(diff.inputChanges.some(row=>row.path.includes("nowMs")));assert.ok(diff.fieldChanges.length>0);
 const unsupported=structuredClone(base);unsupported.unknownInput={value:1};capture("unsupported",unsupported);
 assert.match(diffFinalizationCapsules(store,"before",store,"unsupported").reason,/Unsupported capture fields/);
 // Comparing old records does not require this machine's runtime, but the two
 // recorded runtimes still must match each other.
 const old=JSON.parse(readFileSync(join(store,"runs/same.json")));old.replayRuntime.node="other-runtime";writeFileSync(join(store,"runs/same.json"),JSON.stringify(old));
 diff=diffFinalizationCapsules(store,"before",store,"same");assert.equal(diff.status,"incomparable");assert.ok(diff.inputChanges.some(row=>row.path.includes("runtime")));
 assert.deepEqual(readFileSync(join(store,"runs/before.json")),bytes);
 const throwing=join(root,"diff-throwing-module");cpSync(moduleDir,throwing,{recursive:true});rmSync(join(throwing,"module.mjs"));const code=Buffer.from("throw new Error('diff must never execute')");writeFileSync(join(throwing,"module.mjs"),code);
 const manifest=JSON.parse(readFileSync(join(throwing,"manifest.json")));manifest.moduleSha256=sha(code);writeFileSync(join(throwing,"manifest.json"),JSON.stringify(manifest));writeFileSync(file,JSON.stringify(base));retainFinalization(store,"different-code",file,throwing);
 diff=diffFinalizationCapsules(store,"before",store,"different-code");assert.equal(diff.status,"unchanged");assert.ok(diff.codeChanges.length>0);
 const stage=join(root,"diff-isolated-toolkit");mkdirSync(join(stage,"tools"),{recursive:true});mkdirSync(join(stage,"crates/pt-wasm/tests"),{recursive:true});cpSync(join(sourceRoot,"tools/search-finalization"),join(stage,"tools/search-finalization"),{recursive:true});
 for(const name of ["baseline_store.mjs","baseline_diff.mjs","baseline_glue.mjs"])cpSync(join(sourceRoot,"crates/pt-wasm/tests",name),join(stage,"crates/pt-wasm/tests",name));
 const isolated=spawnSync(process.execPath,[join(stage,"tools/search-finalization/cli.mjs"),"diff",store,"before",store,"different-code"],{encoding:"utf8"});assert.equal(isolated.status,0,isolated.stderr);assert.equal(JSON.parse(isolated.stdout).status,"unchanged");assert.equal(existsSync(join(stage,"packages")),false);
 const recordFile=join(store,"artifacts",before.artifacts.record),original=readFileSync(recordFile);writeFileSync(recordFile,"corrupt");assert.throws(()=>diffFinalizationCapsules(store,"before",store,"different-code"),/integrity/);writeFileSync(recordFile,original);
});

test("captured applied transfer rules re-execute floor lookups and require module capability",()=>{
 const first={type:"transit",tripId:"T1",routeId:"R1",fromStopId:"A",toStopId:"B",departSecs:100,arriveSecs:300,boardStopIdx:0,alightStopIdx:1};
 const second={type:"transit",tripId:"T2",routeId:"R2",fromStopId:"B",toStopId:"C",departSecs:350,arriveSecs:800,boardStopIdx:0,alightStopIdx:1};
 const index={transferRules:new Map([["B\tB",{type:3}]]),transferRulesRouteScoped:new Map([["B\tB\tR1\tR2",{type:2,minSecs:30}]]),transferRulesTripScoped:new Map([["B\tB\tT1\tT2",{type:1}]])};
 let record;compiled.finalizeSearch({composed:[{sourceWalkSecs:0,destWalkSecs:0,departureSecs:0,arrivalSecs:800,totalSecs:800,totalWalkSecs:0,totalWalkMeters:0,transfers:1,legs:[first,second]}],
  walking:null,ranking:"fastest",maxResults:5,minTransferSecs:120},()=>null,(a,b)=>compiled.effectiveTransferFloor(index,a,b,120),r=>{record=r;},()=>compiled.captureTransferFloorState(index));
 assert.equal(record.output.length,1);assert.equal(record.floorRules.trip[0][1].type,1);
 const path=join(root,"floor-record.json"),store=join(root,"floor-store");writeFileSync(path,JSON.stringify(record));retainFinalization(store,"floor",path,moduleDir);
 const proof=replayFinalizationCapsule(store,"floor",join(root,"floor-replay"));assert.equal(proof.completion,"success");assert.deepEqual(proof.output,record.output);assert.ok(proof.transferFloor.lookups>0);assert.match(proof.transferFloor.verification,/recomputed/);
 const legacy=join(root,"module-without-floor-capability");cpSync(moduleDir,legacy,{recursive:true});
 const manifest=JSON.parse(readFileSync(join(legacy,"manifest.json")));delete manifest.transferFloorReplay;writeFileSync(join(legacy,"manifest.json"),JSON.stringify(manifest));
 const refused=join(root,"floor-unsupported-store");assert.throws(()=>retainFinalization(refused,"floor",path,legacy),/transfer rules/);assert.equal(existsSync(refused),false);
 record=JSON.parse(JSON.stringify(record));record.floorRules.trip[0][1].type=3;writeFileSync(path,JSON.stringify(record));retainFinalization(store,"wrong-rules",path,moduleDir);
 const failed=replayFinalizationCapsule(store,"wrong-rules",join(root,"floor-wrong-replay"));assert.equal(failed.completion,"error");assert.equal(failed.output,null);
 assert.match(readFileSync(join(root,"floor-wrong-replay/stderr.txt"),"utf8"),/floor differs/);
 const malformed=JSON.parse(JSON.stringify(record));malformed.reads=[null];writeFileSync(path,JSON.stringify(malformed));retainFinalization(store,"invalid-reads",path,moduleDir);
 const invalid=replayFinalizationCapsule(store,"invalid-reads",join(root,"floor-invalid-read-replay"));assert.equal(invalid.completion,"error");assert.equal(invalid.output,null);assert.equal(invalid.transferFloor,null);assert.ok(existsSync(join(root,"floor-invalid-read-replay/verification.json")));
 const diff=diffFinalizationCapsules(store,"floor",store,"wrong-rules");assert.equal(diff.status,"incomparable");assert.ok(diff.inputChanges.some(change=>change.path.includes("floor")));
});
