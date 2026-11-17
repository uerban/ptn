import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {release} from "node:os";
import {spawnSync} from "node:child_process";
import {readArtifact} from "./baseline_store.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const producerRuntime = () => ({platform: process.platform, arch: process.arch, release: release()});

/** Retained native executables are trusted code, just as retained engine glue.
 * This boundary rebuilds GTFS into PTB; it does not rebuild the producer or
 * assert network isolation. The caller controls OS-level network restrictions. */
export function rebuildBaseline(store, runId, destination) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("Invalid run ID");
  const manifestBytes = readFileSync(join(store,"runs",`${runId}.json`));
  const record = JSON.parse(manifestBytes);
  if (record.schemaVersion !== 1 || record.completion !== "success") throw new Error("Unsupported run manifest");
  if (typeof record.artifacts?.producerRebuildSpec !== "string" || typeof record.artifacts?.producerExecutable !== "string") {
    throw new Error("Run does not declare retained producer rebuild inputs");
  }
  const spec = JSON.parse(readArtifact(store,record.artifacts.producerRebuildSpec));
  if (spec.schemaVersion !== 1 || spec.tool !== "pt-ptb-v2-stage"
      || !Array.isArray(spec.sources) || !spec.sources.length
      || !spec.sources.every(name => typeof name === "string" && Object.hasOwn(record.artifacts,name))
      || new Set(spec.sources).size !== spec.sources.length
      || !Number.isSafeInteger(spec.anchorDate) || !/^\d{8}$/.test(String(spec.anchorDate))
      || typeof spec.timezone !== "string" || !spec.timezone
      || !["auto","off"].includes(spec.deriveInseat)
      || !Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 2147483647) {
    throw new Error("Unsupported producer rebuild specification");
  }
  const runtime = producerRuntime();
  if (!Object.entries(runtime).every(([key,value]) => spec.runtime?.[key] === value)) {
    throw new Error("Producer runtime mismatch or incomplete metadata");
  }
  const needed = new Set(["producerExecutable","ptb",...spec.sources]);
  const bytes = Object.create(null);
  // Check every declared artifact before creating output, including provenance
  // inputs that neither this build nor the narrower engine replay executes.
  for (const [name,digest] of Object.entries(record.artifacts)) {
    const value = readArtifact(store,digest);
    if (needed.has(name)) bytes[name] = value;
  }
  for (const name of needed) if (!bytes[name]) throw new Error(`Missing rebuild artifact: ${name}`);
  mkdirSync(destination);
  const executable = join(destination,"pt-ptb-v2-stage");
  writeFileSync(executable,bytes.producerExecutable,{flag:"wx",mode:0o700});
  const inputs = spec.sources.map((name,index) => {
    const path = join(destination,`input-${index}.zip`);
    writeFileSync(path,bytes[name],{flag:"wx",mode:0o400});
    return {name,path};
  });
  const output = join(destination,"output");
  const args = [...inputs.flatMap(({path}) => ["--gtfs",path]),
    "--timezone",spec.timezone,"--anchor-date",String(spec.anchorDate),
    "--derive-inseat",spec.deriveInseat,"--out-dir",output];
  const result = spawnSync(executable,args,{timeout:spec.timeoutMs,killSignal:"SIGKILL",maxBuffer:16*1024*1024});
  writeFileSync(join(destination,"stdout.bin"),result.stdout ?? Buffer.alloc(0),{flag:"wx"});
  writeFileSync(join(destination,"stderr.bin"),result.stderr ?? Buffer.alloc(0),{flag:"wx"});
  let actualPTB, outputError;
  try {actualPTB = hash(readFileSync(join(output,"bundle.ptb")));}
  catch (error) {outputError = error.message;}
  const auditErrors = [];
  const observedHash = path => {
    try {return hash(readFileSync(path));}
    catch (error) {auditErrors.push(error.message);return null;}
  };
  const inputsUnchanged = inputs.every(({name,path}) => observedHash(path) === record.artifacts[name]);
  const executableUnchanged = observedHash(executable) === record.artifacts.producerExecutable;
  const verified = !result.error && result.status === 0 && inputsUnchanged && executableUnchanged
    && actualPTB === record.artifacts.ptb;
  const verification = {
    schemaVersion:1, scope:"GTFS-to-PTB with retained producer executable",
    runId, runManifestSha256:hash(manifestBytes), producerRebuildSpec:record.artifacts.producerRebuildSpec,
    producerExecutable:record.artifacts.producerExecutable,
    sources:spec.sources.map(name=>({artifact:name,sha256:record.artifacts[name]})),
    producerRebuildVerified:verified, compilerRebuildVerified:false,
    networkIsolation:"not asserted by this helper", runtime,
    expectedPTB:record.artifacts.ptb, actualPTB:actualPTB ?? null,
    inputsUnchanged, executableUnchanged, exitCode:result.status, signal:result.signal,
    completion:result.error?.code === "ETIMEDOUT" ? "timeout" : verified ? "success" : "error",
    outputTruncated:result.error?.code === "ENOBUFS",
    unsupported:["producer compiler/toolchain rebuild", "external subprocess cleanup"],
    ...(auditErrors.length ? {auditErrors} : {}),
    ...(result.error ? {processError:result.error.message} : {}),
    ...(outputError ? {outputError} : {}),
  };
  writeFileSync(join(destination,"verification.json"),`${JSON.stringify(verification,null,2)}\n`,{flag:"wx"});
  if (!verified) throw new Error(`Producer rebuild did not verify; see ${join(destination,"verification.json")}`);
  return verification;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error("usage: baseline_rebuild.mjs <store> <run-id> <fresh-destination>");
    console.log(JSON.stringify(rebuildBaseline(resolve(process.argv[2]),process.argv[3],resolve(process.argv[4]))));
  } catch (error) {console.error(error.message);process.exitCode=1;}
}
