import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync,cpSync,existsSync,statSync,renameSync,mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildFinalizationModule,sha,sourceRoot} from "../../../tools/search-finalization/module.mjs";
import {retainFinalization,replayFinalizationCapsule} from "../../../tools/search-finalization/capsule.mjs";
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
 const path=join(root,"empty-record.json"),store=join(root,"empty-store");writeFileSync(path,JSON.stringify(record));
 retainFinalization(store,"empty",path,moduleDir);
 const proof=replayFinalizationCapsule(store,"empty",join(root,"empty-replay"));
 assert.equal(proof.completion,"success");assert.deepEqual(proof.output,[]);
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
 record.planner.query.entryStops[0].walkSecs++;
 writeFileSync(path,JSON.stringify(record));retainFinalization(store,"disconnected",path,moduleDir);
 const failed=replayFinalizationCapsule(store,"disconnected",join(root,"pipeline-disconnected-replay"));
 assert.equal(failed.completion,"error");assert.equal(failed.output,null);
 assert.match(readFileSync(join(root,"pipeline-disconnected-replay/stderr.txt"),"utf8"),/planner entry/);
});
