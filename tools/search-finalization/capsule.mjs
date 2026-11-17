import {readFileSync,writeFileSync,mkdirSync,openSync,readSync,closeSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {release} from "node:os";
import {spawnSync} from "node:child_process";
import {retainArtifact,readArtifact,retainRun} from "../../crates/pt-wasm/tests/baseline_store.mjs";
import {sha} from "./module.mjs";

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

/** Verify every declared byte before materialization. Explicit replay executes
 * retained trusted code with a bounded process; this is not a security sandbox. */
export function replayFinalizationCapsule(store,id,destination,timeoutMs=5000) {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw new Error("Invalid run ID");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new Error("Invalid replay timeout");
  const manifestBytes=readFileSync(join(store,"runs",`${id}.json`)),capsule=JSON.parse(manifestBytes);
  if(capsule.schemaVersion!==1||capsule.format!=="ptn-search-finalization-capsule"||!Object.values(SCOPES).includes(capsule.scope)||capsule.classification!=="partial capture"||capsule.replayVerification!=="unverified"||capsule.recordProducerIdentity!==PRODUCER_UNVERIFIED||!capsule.artifacts||typeof capsule.artifacts!=="object")throw new Error("Unsupported capsule");
  const observed=Object.fromEntries(Object.entries(capsule.artifacts).map(([name,hash])=>[name,readArtifact(store,hash)]));
  for(const name of ["module","record","moduleBuild","replayChild"])if(!observed[name])throw new Error(`Missing capsule artifact: ${name}`);
  const record=checkRecord(observed.record);
  const build=JSON.parse(observed.moduleBuild);checkModule(build);
  if(!(build.recordFormats??["ptn-search-finalization"]).includes(record.format)||scopeOf(record)!==capsule.scope)throw new Error("Capsule scope mismatch");
  if(build.moduleSha256!==capsule.artifacts.module||build.sources.some((row,index)=>capsule.artifacts[`source${index}`]!==row.sha256))throw new Error("Capsule module provenance mismatch");
  if(!same(capsule.replayRuntime,runtime()))throw new Error("Replay runtime mismatch");
  mkdirSync(destination,{mode:0o700});
  const modulePath=join(destination,"module.mjs"),recordPath=join(destination,"record.json");
  writeFileSync(modulePath,observed.module,{flag:"wx",mode:0o400});writeFileSync(recordPath,observed.record,{flag:"wx",mode:0o400});
  const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;
  const started=performance.now();
  const child=spawnSync(process.execPath,["--input-type=module","-e",observed.replayChild.toString("utf8"),modulePath,recordPath,capsule.artifacts.module,capsule.artifacts.record],
    {env,timeout:timeoutMs,maxBuffer:4*1024*1024,encoding:"utf8",killSignal:"SIGKILL"});
  writeFileSync(join(destination,"stdout.txt"),child.stdout??"",{flag:"wx",mode:0o600});
  writeFileSync(join(destination,"stderr.txt"),child.stderr??"",{flag:"wx",mode:0o600});
  let completion=child.error?.code==="ETIMEDOUT"?"timeout":child.status===0&&!child.error?"success":"error";
  let result=null;
  if(completion==="success") {
    try {result=JSON.parse(child.stdout);if(result.completion!=="success"||result.moduleHash!==capsule.artifacts.module||result.recordHash!==capsule.artifacts.record
      ||!same(result.output,record.output))throw new Error("Replay proof mismatch");}
    catch {completion="error";}
  }
  const proof={format:"ptn-search-finalization-replay",version:1,scope:capsule.scope,classification:capsule.classification,recordProducerIdentity:capsule.recordProducerIdentity,manifestSha256:sha(manifestBytes),artifacts:capsule.artifacts,
    completion,elapsedMs:performance.now()-started,exitCode:child.status,signal:child.signal,errorCode:child.error?.code??null,
    logCaptureComplete:child.error?.code!=="ENOBUFS",output:completion==="success"?result.output:null};
  writeFileSync(join(destination,"verification.json"),JSON.stringify(proof,null,2)+"\n",{flag:"wx",mode:0o600});
  return proof;
}
