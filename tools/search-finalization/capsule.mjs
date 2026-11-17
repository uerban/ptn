import {readFileSync,writeFileSync,mkdirSync,openSync,readSync,closeSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import {createHash} from "node:crypto";
import {release} from "node:os";
import {spawnSync} from "node:child_process";
import {retainArtifact,readArtifact,retainRun} from "../../crates/pt-wasm/tests/baseline_store.mjs";
import {sha} from "./module.mjs";
import {rtDelayReads} from "./rt-requests.mjs";
import {walkingRequests} from "./walking.mjs";

function runtime() {
  const hash=createHash("sha256"),fd=openSync(process.execPath,"r"),buffer=Buffer.alloc(65536);
  try {let count;while((count=readSync(fd,buffer))>0)hash.update(buffer.subarray(0,count));}finally{closeSync(fd);}
  return {node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,release:release(),nodeExecutableSha256:hash.digest("hex")};
}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const SCOPES={"ptn-search-finalization":"frontend RT feasibility and ranking","ptn-search-composition":"frontend post-planner walking composition","ptn-search-reach":"frontend directed endpoint reach","ptn-search-pipeline":"frontend linked stages with observed planner"};
const scopeOf=record=>record.scope===undefined?(record.format==="ptn-search-reach"?SCOPES[record.format]:undefined):record.scope;
const PRODUCER_UNVERIFIED="unverified; imported observation is not proof of original application bytes/runtime";
const digest=value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
function checkModule(manifest) {
  if(manifest?.format!=="ptn-search-finalization-module"||manifest.version!==1||!digest(manifest.moduleSha256)
    ||!Array.isArray(manifest.sources)||!manifest.sources.length||manifest.sources.some(row=>!digest(row.sha256)||typeof row.path!=="string"))throw new Error("Invalid module manifest");
  if(manifest.recordFormats!==undefined&&(!Array.isArray(manifest.recordFormats)||!manifest.recordFormats.length||manifest.recordFormats.some(format=>!Object.hasOwn(SCOPES,format))))throw new Error("Invalid module formats");
}

function checkTimeFrameSupport(record,build) {
  if(record.format==="ptn-search-pipeline"&&Object.hasOwn(record,"timeFrame")&&build.timeFrameReplay!=="ptn-time-frame-v1")throw new Error("Module does not support captured time frame");
}
function checkRecord(bytes) {
  if(bytes.length>2*1024*1024)throw new Error("Finalization record exceeds limit");
  const record=JSON.parse(bytes);
  if(!Object.hasOwn(SCOPES,record?.format)||record.version!==1||scopeOf(record)!==SCOPES[record.format]
    ||record.classification!=="partial capture"||record.normalization!=="finite-json-wire-v1"
    ||(record.format!=="ptn-search-reach"&&record.format!=="ptn-search-pipeline"&&!Number.isFinite(record.nowMs))
    ||(record.format==="ptn-search-pipeline"?(!record.query||!record.reach||!record.composition):(!record.input||!Array.isArray(record.reads)))||!Array.isArray(record.output))throw new Error("Unsupported finalization record");
  const finite=value=>{if(typeof value==="number"&&!Number.isFinite(value))throw new Error("Non-finite finalization value");if(value&&typeof value==="object")Object.values(value).forEach(finite);};
  finite(record);return record;
}

/** Read/verify only; capture never executes the supplied module. */
export function retainFinalization(store,id,recordPath,moduleDirectory) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new Error("Invalid run ID");
  const recordBytes=readFileSync(recordPath);
  const record=checkRecord(recordBytes);
  const manifestBytes=readFileSync(join(moduleDirectory,"manifest.json")),manifest=JSON.parse(manifestBytes);checkModule(manifest);
  checkTimeFrameSupport(record,manifest);
  if(!(manifest.recordFormats??["ptn-search-finalization"]).includes(record.format))throw new Error("Module does not support capture format");
  const module=readFileSync(join(moduleDirectory,"module.mjs"));
  if(sha(module)!==manifest.moduleSha256)throw new Error("Module integrity mismatch");
  const sources=manifest.sources.map(row=>{const bytes=readFileSync(join(moduleDirectory,"sources",row.sha256));if(sha(bytes)!==row.sha256)throw new Error("Source integrity mismatch");return bytes;});
  mkdirSync(store,{recursive:true,mode:0o700});
  const artifacts={record:retainArtifact(store,recordBytes),module:retainArtifact(store,module),moduleBuild:retainArtifact(store,manifestBytes),
    replayChild:retainArtifact(store,readFileSync(new URL("./replay-child.mjs",import.meta.url)))};
  sources.forEach((bytes,index)=>{artifacts[`source${index}`]=retainArtifact(store,bytes);});
  const capsule={schemaVersion:1,format:"ptn-search-finalization-capsule",scope:scopeOf(record),classification:"partial capture",
    replayVerification:"unverified",artifacts,replayRuntime:runtime(),
    recordProducerIdentity:PRODUCER_UNVERIFIED,
    missingDependencies:record.format==="ptn-search-pipeline"
      ? ["endpoint selection and readiness wait before reach","planner/time-frame/service eligibility execution and artifacts","raw pedestrian graphs and provider execution","raw RT feeds before lookup","hermetic compiler/runtime rebuild","original capture producer module/runtime identity"]
      : record.format==="ptn-search-reach"
      ? ["endpoint selection before reach resolution","OSRM module/graph and transfer-table artifacts","planner execution","hermetic compiler/runtime rebuild","original capture producer module/runtime identity"]
      : ["upstream endpoint reach and planner execution","raw pedestrian graph and route execution","raw RT feeds before lookup","hermetic compiler/runtime rebuild","original capture producer module/runtime identity"]};
  retainRun(store,id,capsule);return capsule;
}

const RT_UNVERIFIED="unverified; supplied RouteUpdate history is not proof of original live RT state";
const GRAPH_UNVERIFIED="unverified; supplied graph state is not proof of original live graph";
const HANDLE_UNVERIFIED="unverified; supplied artifact state is not proof of original live router";
function readCapsule(store,id,verifyRuntime=true) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new Error("Invalid run ID");
  const manifestBytes=readFileSync(join(store,"runs",`${id}.json`)),capsule=JSON.parse(manifestBytes);
  if(capsule.schemaVersion!==1||capsule.format!=="ptn-search-finalization-capsule"||!Object.values(SCOPES).includes(capsule.scope)||capsule.classification!=="partial capture"||capsule.replayVerification!=="unverified"||capsule.recordProducerIdentity!==PRODUCER_UNVERIFIED||!capsule.artifacts||typeof capsule.artifacts!=="object")throw new Error("Unsupported capsule");
  const observed=Object.fromEntries(Object.entries(capsule.artifacts).map(([name,hash])=>[name,readArtifact(store,hash)]));
  for(const name of ["module","record","moduleBuild","replayChild"])if(!observed[name])throw new Error(`Missing capsule artifact: ${name}`);
  const record=checkRecord(observed.record);
  const build=JSON.parse(observed.moduleBuild);checkModule(build);checkTimeFrameSupport(record,build);
  if(!(build.recordFormats??["ptn-search-finalization"]).includes(record.format)||scopeOf(record)!==capsule.scope)throw new Error("Capsule scope mismatch");
  if(build.moduleSha256!==capsule.artifacts.module||build.sources.some((row,index)=>capsule.artifacts[`source${index}`]!==row.sha256))throw new Error("Capsule module provenance mismatch");
  if(verifyRuntime&&!same(capsule.replayRuntime,runtime()))throw new Error("Replay runtime mismatch");
  if(capsule.plannerExecution!==undefined) {
    const config=capsule.plannerExecution;
    if(config.version!==1||!["off","unbounded","covering-merge"].includes(config.patternMode)||typeof config.transfers!=="boolean"
      ||config.originalHandleIdentity!==HANDLE_UNVERIFIED||record.format!=="ptn-search-pipeline"||!record.planner
      ||build.plannerQueryMapping!=="ptn-wasm-query-v1")throw new Error("Unsupported planner execution capsule");
    for(const name of ["plannerSourceCapsule","plannerOriginalChild","plannerGlue","plannerWasm","plannerPtb",...(config.transfers?["plannerTransfers"]:[])])if(!observed[name])throw new Error(`Missing planner artifact: ${name}`);
    if(!config.transfers&&observed.plannerTransfers)throw new Error("Unexpected planner transfer artifact");
    const source=JSON.parse(observed.plannerSourceCapsule);
    if(source.plannerExecution!==undefined||source.format!==capsule.format||source.scope!==capsule.scope||!same(source.replayRuntime,capsule.replayRuntime))throw new Error("Planner source capsule mismatch");
    for(const [name,hash] of Object.entries(source.artifacts??{}))if((name==="replayChild"?capsule.artifacts.plannerOriginalChild:capsule.artifacts[name])!==hash)throw new Error("Planner source artifact mismatch");
    for(const name of ["record","module","moduleBuild","replayChild"])if(!source.artifacts?.[name])throw new Error("Incomplete planner source capsule");
  }
  if(capsule.walkingExecution!==undefined) {
    const config=capsule.walkingExecution;
    if(config.version!==1||!validWalkingCity(config.cityId)||config.originalGraphIdentity!==GRAPH_UNVERIFIED)throw new Error("Unsupported walking execution capsule");
    walkingRequests(record,config.profile);
    for(const name of ["walkingSourceCapsule","walkingOriginalChild","walkingGlue","walkingWasm","walkingGraph","walkingRequestBuilder"])if(!observed[name])throw new Error(`Missing walking artifact: ${name}`);
    const source=JSON.parse(observed.walkingSourceCapsule);
    if(source.walkingExecution!==undefined||source.format!==capsule.format||source.scope!==capsule.scope||!same(source.replayRuntime,capsule.replayRuntime))throw new Error("Walking source capsule mismatch");
    for(const [name,hash] of Object.entries(source.artifacts??{}))if((name==="replayChild"?capsule.artifacts.walkingOriginalChild:capsule.artifacts[name])!==hash)throw new Error("Walking source artifact mismatch");
    for(const name of ["record","module","moduleBuild","replayChild"])if(!source.artifacts?.[name])throw new Error("Incomplete walking source capsule");
  }
  if(capsule.rtExecution!==undefined) {
    const config=capsule.rtExecution;
    if(config.version!==1||config.originalRtIdentity!==RT_UNVERIFIED)throw new Error("Unsupported RT execution capsule");
    rtDelayReads(record);
    for(const name of ["rtSourceCapsule","rtOriginalChild","rtModule","rtBuild","rtEventInput","rtEvents","rtRequestBuilder"])if(!observed[name])throw new Error(`Missing RT artifact: ${name}`);
    const build=JSON.parse(observed.rtBuild);
    if(build.format!=="ptn-rt-envelope-module"||build.version!==1||build.moduleSha256!==capsule.artifacts.rtModule||!Array.isArray(build.sources)||!build.sources.length
      ||build.sources.some((row,index)=>!digest(row.sha256)||typeof row.path!=="string"||capsule.artifacts[`rtSource${index}`]!==row.sha256))throw new Error("RT module provenance mismatch");
    const events=JSON.parse(observed.rtEvents);
    if(!Array.isArray(events))throw new Error("Invalid RT event history");
    for(const event of events) {
      if(event.kind==="update") {if(!Number.isFinite(event.receivedAt)||!digest(event.artifact)||capsule.artifacts[`rtEnvelope${event.artifact}`]!==event.artifact||!observed[`rtEnvelope${event.artifact}`])throw new Error("Missing RT envelope");}
      else if(event.kind!=="remove"||!Array.isArray(event.routeIds)||event.routeIds.some(id=>typeof id!=="string"))throw new Error("Invalid RT event");
    }
    const source=JSON.parse(observed.rtSourceCapsule);
    if(source.rtExecution!==undefined||source.format!==capsule.format||source.scope!==capsule.scope||!same(source.replayRuntime,capsule.replayRuntime))throw new Error("RT source capsule mismatch");
    for(const [name,hash] of Object.entries(source.artifacts??{}))if((name==="replayChild"?capsule.artifacts.rtOriginalChild:capsule.artifacts[name])!==hash)throw new Error("RT source artifact mismatch");
    for(const name of ["record","module","moduleBuild","replayChild"])if(!source.artifacts?.[name])throw new Error("Incomplete RT source capsule");
  }
  return {manifestBytes,capsule,observed,record,build};
}

/** Read-only inspection verifies all bytes and provenance, without executing
 * retained code or requiring this machine to be the recorded replay host. */
export function inspectFinalizationCapsule(store,id) {
  const {manifestBytes,capsule,record,build,observed}=readCapsule(store,id,false);
  return {manifestSha256:sha(manifestBytes),capsule,record,build,
    rtEvents:observed.rtEvents?JSON.parse(observed.rtEvents):null};
}

/** Retain supplied router state without executing it. The new immutable run
 * preserves the original observation and does not verify its live handle. */
export function attachPlannerReplay(store,sourceId,id,{glue,wasm,ptb,transfers,patternMode}) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new Error("Invalid run ID");
  if(!["off","unbounded","covering-merge"].includes(patternMode)||!(transfers===null||typeof transfers==="string"))throw new Error("Explicit pattern mode and transfers path or null required");
  const {manifestBytes,capsule,record,build}=readCapsule(store,sourceId);
  if(capsule.plannerExecution!==undefined||record.format!=="ptn-search-pipeline"||!record.planner||build.plannerQueryMapping!=="ptn-wasm-query-v1")throw new Error("Planner replay requires an unattached pipeline and declared query mapping");
  const bytes={plannerGlue:readFileSync(glue),plannerWasm:readFileSync(wasm),plannerPtb:readFileSync(ptb),...(transfers!==null?{plannerTransfers:readFileSync(transfers)}:{})};
  const artifacts={...capsule.artifacts,plannerSourceCapsule:retainArtifact(store,manifestBytes),plannerOriginalChild:capsule.artifacts.replayChild,
    replayChild:retainArtifact(store,readFileSync(new URL("./replay-child.mjs",import.meta.url)))};
  for(const [name,value] of Object.entries(bytes))artifacts[name]=retainArtifact(store,value);
  const attached={...capsule,artifacts,plannerExecution:{version:1,patternMode,transfers:transfers!==null,originalHandleIdentity:HANDLE_UNVERIFIED}};
  retainRun(store,id,attached);return attached;
}

const validWalkingCity=value=>typeof value==="string"&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);

/** Retain decoded graph state as a new immutable run, without executing glue. */
export function attachWalkingReplay(store,sourceId,id,{glue,wasm,graph,cityId,profile}) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new Error("Invalid run ID");
  if(!validWalkingCity(cityId))throw new Error("Explicit walking city ID required");
  const {manifestBytes,capsule,record}=readCapsule(store,sourceId);
  if(capsule.walkingExecution!==undefined)throw new Error("Walking replay already attached");
  walkingRequests(record,profile);
  const bytes={walkingGlue:readFileSync(glue),walkingWasm:readFileSync(wasm),walkingGraph:readFileSync(graph),
    walkingRequestBuilder:readFileSync(new URL("./walking.mjs",import.meta.url))};
  const artifacts={...capsule.artifacts,walkingSourceCapsule:retainArtifact(store,manifestBytes),walkingOriginalChild:capsule.artifacts.replayChild,
    replayChild:retainArtifact(store,readFileSync(new URL("./replay-child.mjs",import.meta.url)))};
  for(const [name,value] of Object.entries(bytes))artifacts[name]=retainArtifact(store,value);
  const attached={...capsule,artifacts,walkingExecution:{version:1,cityId,profile,originalGraphIdentity:GRAPH_UNVERIFIED}};
  retainRun(store,id,attached);return attached;
}

/** Supplied static frontend RouteUpdate history, beginning with an empty store.
 * No supplied decoder module executes during attachment. */
export function attachRtReplay(store,sourceId,id,{moduleDirectory,eventsPath}) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new Error("Invalid run ID");
  const {manifestBytes,capsule,record}=readCapsule(store,sourceId);
  if(capsule.rtExecution!==undefined)throw new Error("RT replay already attached");rtDelayReads(record);
  const buildBytes=readFileSync(join(moduleDirectory,"manifest.json")),build=JSON.parse(buildBytes);
  if(build.format!=="ptn-rt-envelope-module"||build.version!==1||!digest(build.moduleSha256)||!Array.isArray(build.sources)||!build.sources.length)throw new Error("Invalid RT module manifest");
  const module=readFileSync(join(moduleDirectory,"module.mjs"));if(sha(module)!==build.moduleSha256)throw new Error("RT module integrity mismatch");
  const sources=build.sources.map(row=>{if(!digest(row.sha256))throw new Error("Invalid RT source");const bytes=readFileSync(join(moduleDirectory,"sources",row.sha256));if(sha(bytes)!==row.sha256)throw new Error("RT source integrity mismatch");return bytes;});
  const eventInput=readFileSync(eventsPath),events=JSON.parse(eventInput);if(!Array.isArray(events))throw new Error("Invalid RT event history");
  const envelopes=new Map();
  const retainedEvents=events.map(event=>{
    if(event.kind==="update"&&typeof event.path==="string"&&Number.isFinite(event.receivedAt)) {
      const bytes=readFileSync(resolve(dirname(eventsPath),event.path)),hash=sha(bytes);envelopes.set(hash,bytes);return {kind:"update",artifact:hash,receivedAt:event.receivedAt};
    }
    if(event.kind==="remove"&&Array.isArray(event.routeIds)&&event.routeIds.every(id=>typeof id==="string"))return {kind:"remove",routeIds:event.routeIds};
    throw new Error("Invalid RT event");
  });
  const artifacts={...capsule.artifacts,rtSourceCapsule:retainArtifact(store,manifestBytes),rtOriginalChild:capsule.artifacts.replayChild,
    replayChild:retainArtifact(store,readFileSync(new URL("./replay-child.mjs",import.meta.url))),rtModule:retainArtifact(store,module),rtBuild:retainArtifact(store,buildBytes),
    rtEventInput:retainArtifact(store,eventInput),rtEvents:retainArtifact(store,Buffer.from(JSON.stringify(retainedEvents))),rtRequestBuilder:retainArtifact(store,readFileSync(new URL("./rt-requests.mjs",import.meta.url)))};
  sources.forEach((bytes,index)=>{artifacts[`rtSource${index}`]=retainArtifact(store,bytes);});
  for(const [hash,bytes] of envelopes)artifacts[`rtEnvelope${hash}`]=retainArtifact(store,bytes);
  const attached={...capsule,artifacts,rtExecution:{version:1,originalRtIdentity:RT_UNVERIFIED}};retainRun(store,id,attached);return attached;
}

/** Verify every declared byte before materialization. Explicit replay executes
 * retained trusted code with a bounded process; this is not a security sandbox. */
export function replayFinalizationCapsule(store,id,destination,timeoutMs=5000) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new Error("Invalid run ID");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new Error("Invalid replay timeout");
  const {manifestBytes,capsule,observed,record}=readCapsule(store,id);
  mkdirSync(destination,{mode:0o700});
  const modulePath=join(destination,"module.mjs"),recordPath=join(destination,"record.json");
  writeFileSync(modulePath,observed.module,{flag:"wx",mode:0o400});writeFileSync(recordPath,observed.record,{flag:"wx",mode:0o400});
  const plannerInput=capsule.plannerExecution?{...capsule.plannerExecution,artifacts:{}}:null;
  if(plannerInput)for(const name of ["plannerGlue","plannerWasm","plannerPtb",...(plannerInput.transfers?["plannerTransfers"]:[])]) {
    const path=join(destination,name);writeFileSync(path,observed[name],{flag:"wx",mode:0o400});
    plannerInput.artifacts[name]={path,sha256:capsule.artifacts[name]};
  }
  const walkingInput=capsule.walkingExecution?{...capsule.walkingExecution,artifacts:{}}:null;
  if(walkingInput)for(const name of ["walkingGlue","walkingWasm","walkingGraph","walkingRequestBuilder"]) {
    const path=join(destination,name);writeFileSync(path,observed[name],{flag:"wx",mode:0o400});
    walkingInput.artifacts[name]={path,sha256:capsule.artifacts[name]};
  }
  const rtInput=capsule.rtExecution?{...capsule.rtExecution,artifacts:{}}:null;
  if(rtInput)for(const name of Object.keys(observed).filter(name=>name==="rtModule"||name==="rtEvents"||name==="rtRequestBuilder"||name.startsWith("rtEnvelope"))) {
    const path=join(destination,name);writeFileSync(path,observed[name],{flag:"wx",mode:0o400});rtInput.artifacts[name]={path,sha256:capsule.artifacts[name]};
  }
  const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;
  const started=performance.now();
  const child=spawnSync(process.execPath,["--input-type=module","-e",observed.replayChild.toString("utf8"),modulePath,recordPath,capsule.artifacts.module,capsule.artifacts.record,JSON.stringify(plannerInput),JSON.stringify(walkingInput),JSON.stringify(rtInput)],
    {env,timeout:timeoutMs,maxBuffer:4*1024*1024,encoding:"utf8",killSignal:"SIGKILL"});
  writeFileSync(join(destination,"stdout.txt"),child.stdout??"",{flag:"wx",mode:0o600});
  writeFileSync(join(destination,"stderr.txt"),child.stderr??"",{flag:"wx",mode:0o600});
  let completion=child.error?.code==="ETIMEDOUT"?"timeout":child.status===0&&!child.error?"success":"error";
  let result=null;
  if(completion==="success") {
    try {result=JSON.parse(child.stdout);if(result.completion!=="success"||result.moduleHash!==capsule.artifacts.module||result.recordHash!==capsule.artifacts.record
      ||!same(result.output,record.output))throw new Error("Replay proof mismatch");
      if(plannerInput&&(!same(result.planner?.output,record.planner.output)||result.planner?.patternMode!==plannerInput.patternMode
        ||!same(result.planner?.artifacts,Object.fromEntries(Object.entries(plannerInput.artifacts).map(([name,row])=>[name,row.sha256])))))throw new Error("Planner replay proof mismatch");
      if(plannerInput&&record.timeFrame?.kind==="engine"&&!same(result.planner?.timeFrame,record.timeFrame))throw new Error("Engine time frame replay proof mismatch");
      if(walkingInput&&(!same(result.walking?.calls,walkingRequests(record,walkingInput.profile))||result.walking?.cityId!==walkingInput.cityId||result.walking?.profile!==walkingInput.profile
        ||!same(result.walking?.artifacts,Object.fromEntries(Object.entries(walkingInput.artifacts).map(([name,row])=>[name,row.sha256])))))throw new Error("Walking replay proof mismatch");
      if(rtInput&&(!same(result.rt?.reads,rtDelayReads(record))||!same(result.rt?.artifacts,Object.fromEntries(Object.entries(rtInput.artifacts).map(([name,row])=>[name,row.sha256])))))throw new Error("RT replay proof mismatch");}
    catch {completion="error";}
  }
  const proof={format:"ptn-search-finalization-replay",version:1,scope:capsule.scope,classification:capsule.classification,recordProducerIdentity:capsule.recordProducerIdentity,manifestSha256:sha(manifestBytes),artifacts:capsule.artifacts,
    planner:completion==="success"?(result.planner??null):null,plannerExecution:capsule.plannerExecution??null,
    walking:completion==="success"?(result.walking??null):null,walkingExecution:capsule.walkingExecution??null,
    rt:completion==="success"?(result.rt??null):null,rtExecution:capsule.rtExecution??null,
    timeFrame:completion==="success"&&record.format==="ptn-search-pipeline"&&record.timeFrame?{observation:record.timeFrame,verification:record.timeFrame.kind==="timezone"?"timezone conversion recomputed":plannerInput?"supplied engine conversion re-executed":"observed engine conversion; arithmetic checked"}:null,
    completion,elapsedMs:performance.now()-started,exitCode:child.status,signal:child.signal,errorCode:child.error?.code??null,
    logCaptureComplete:child.error?.code!=="ENOBUFS",output:completion==="success"?result.output:null};
  writeFileSync(join(destination,"verification.json"),JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600});
  return proof;
}
