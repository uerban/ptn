import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,unlinkSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {retainArtifact,retainRun} from "./baseline_store.mjs";
import {rebuildBaseline,producerRuntime} from "./baseline_rebuild.mjs";

// Toy executable tests the driver, not GTFS parsing. The real retained producer
// is exercised separately against a real feed under OS network denial.
const compiler = `const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2);
 const inputs=[];for(let i=0;i<args.length;i++)if(args[i]==="--gtfs")inputs.push(args[++i]);
 if(args[args.indexOf("--anchor-date")+1]!=="20261113"||args[args.indexOf("--timezone")+1]!=="Europe/Vilnius"||args[args.indexOf("--derive-inseat")+1]!=="auto")process.exit(7);
 const out=args[args.indexOf("--out-dir")+1];fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,"bundle.ptb"),Buffer.concat(inputs.map(p=>fs.readFileSync(p))));
 console.log("fixture producer completed");`;
function setup({body=compiler, expected="AB", sources=["sourceA","sourceB"], runtime=producerRuntime(), timeoutMs=5000}={}) {
  const root=mkdtempSync(join(tmpdir(),"baseline-rebuild-"));
  const bytes={ptb:Buffer.from(expected),sourceA:Buffer.from("A"),sourceB:Buffer.from("B"),
    producerExecutable:Buffer.from(`#!${process.execPath}\n${body}\n`),extra:Buffer.from("provenance")};
  const spec={schemaVersion:1,tool:"pt-ptb-v2-stage",sources,runtime,anchorDate:20261113,timezone:"Europe/Vilnius",deriveInseat:"auto",timeoutMs};
  bytes.producerRebuildSpec=Buffer.from(JSON.stringify(spec));
  const artifacts=Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,retainArtifact(root,v)]));
  retainRun(root,"baseline",{schemaVersion:1,completion:"success",artifacts});
  return {root,artifacts,destination:join(root,"restored")};
}
const unix={skip:process.platform==="win32"};

test("rebuilds ordered retained sources and preserves immutable attempts",unix,()=>{
 const {root,destination,artifacts}=setup();
 try {
  const result=rebuildBaseline(root,"baseline",destination);
  assert.equal(result.producerRebuildVerified,true);
  assert.equal(result.compilerRebuildVerified,false);
  assert.equal(result.actualPTB,artifacts.ptb);
  assert.equal(result.networkIsolation,"not asserted by this helper");
  assert.deepEqual(result.sources.map(s=>s.artifact),["sourceA","sourceB"]);
  assert.equal(result.runManifestSha256,createHash("sha256").update(readFileSync(join(root,"runs","baseline.json"))).digest("hex"));
  const original=readFileSync(join(destination,"verification.json"));
  assert.throws(()=>rebuildBaseline(root,"baseline",destination),/EEXIST/);
  assert.deepEqual(readFileSync(join(destination,"verification.json")),original);
 }finally{rmSync(root,{recursive:true,force:true});}
});
for(const name of ["sourceA","producerExecutable","extra"])for(const damage of ["missing","corrupt"]){
 test(`rejects ${damage} ${name} before creating rebuild output`,()=>{
  const {root,destination,artifacts}=setup();
  try{
   const path=join(root,"artifacts",artifacts[name]);
   if(damage==="missing")unlinkSync(path);else writeFileSync(path,"corrupt");
   assert.throws(()=>rebuildBaseline(root,"baseline",destination),/ENOENT|integrity/);
   assert.equal(existsSync(destination),false);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
}
test("rejects a runtime mismatch before executing producer code",()=>{
 const {root,destination}=setup({runtime:{...producerRuntime(),arch:"other"}});
 try{
  assert.throws(()=>rebuildBaseline(root,"baseline",destination),/runtime mismatch/);
  assert.equal(existsSync(destination),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
for(const [label,options,status] of [
 ["output hash mismatch",{expected:"different"},"error"],
 ["source order change",{sources:["sourceB","sourceA"]},"error"],
 ["producer failure",{body:'console.error("fixture failed");process.exit(23);'},"error"],
 ["producer timeout",{body:'while(true){}',timeoutMs:100},"timeout"],
]){
 test(`retains a failed verification for ${label}`,unix,()=>{
  const {root,destination}=setup(options);
  try{
   assert.throws(()=>rebuildBaseline(root,"baseline",destination),/did not verify/);
   const result=JSON.parse(readFileSync(join(destination,"verification.json")));
   assert.equal(result.producerRebuildVerified,false);
   assert.equal(result.completion,status);
   assert.equal(existsSync(join(destination,"stdout.bin")),true);
   assert.equal(existsSync(join(destination,"stderr.bin")),true);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
}

test("engine-only legacy captures do not implicitly authorize a producer command",()=>{
 const root=mkdtempSync(join(tmpdir(),"baseline-engine-only-"));
 try{
  retainRun(root,"baseline",{schemaVersion:1,completion:"success",artifacts:{ptb:retainArtifact(root,Buffer.from("PTB"))}});
  const destination=join(root,"restored");
  assert.throws(()=>rebuildBaseline(root,"baseline",destination),/does not declare retained producer rebuild inputs/);
  assert.equal(existsSync(destination),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
