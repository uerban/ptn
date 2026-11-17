import {createRequire} from "node:module";
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from "node:fs";
import {join,relative,dirname,resolve} from "node:path";
import {sha,sourceRoot} from "./module.mjs";

export function rtCompilerInputName(root,dependencyRoot,actual) {
  const inSource=relative(root,actual),inDependencies=relative(dependencyRoot,actual);
  return !inDependencies.startsWith("..")?`dependencies/${inDependencies}`:!inSource.startsWith("..")?inSource:null;
}

/** Decoder dependencies are compiler inputs too: retain their consumed bytes.
 * Resolver/compiler installation is recorded, not hermetically reconstructible. */
export async function buildRtModule(destination) {
  const require=createRequire(realpathSync(join(sourceRoot,"packages/frontend/node_modules/vite/package.json"))),esbuild=require("esbuild");
  const protobuf=realpathSync(join(sourceRoot,"packages/shared/node_modules/protobufjs/package.json"));
  const marker="/node_modules/.pnpm/",index=protobuf.indexOf(marker);
  if(index<0)throw new Error("RT builder requires the installed pnpm dependency store");
  const dependencyRoot=protobuf.slice(0,index)+marker.slice(0,-1),observed=new Map();
  const options={bundle:true,platform:"browser",format:"esm",target:"node22",treeShaking:true,tsconfigRaw:{compilerOptions:{target:"ES2022",useDefineForClassFields:true}}};
  const result=await esbuild.build({...options,absWorkingDir:sourceRoot,entryPoints:["packages/frontend/src/services/rtEnvelopeReplay.ts"],write:false,metafile:true,
    plugins:[{name:"retained-rt-inputs",setup(build){
      // The browser decoder never loads .proto files from disk. Make the usual
      // browser fs stub explicit so even its compiler input bytes are retained.
      build.onResolve({filter:/^fs$/},()=>({path:"fs",namespace:"rt-browser-stub"}));
      build.onLoad({filter:/.*/,namespace:"rt-browser-stub"},()=>{
        const bytes=Buffer.from("module.exports = {};\n");observed.set("virtual/browser-fs.js",bytes);return {contents:bytes.toString(),loader:"js"};
      });
      build.onResolve({filter:/^@pt\/shared\/proto$/},()=>({path:join(sourceRoot,"packages/shared/src/proto/route-update.ts")}));
      build.onLoad({filter:/\.(?:m?js|ts|json)$/},args=>{
        const actual=realpathSync(args.path),path=rtCompilerInputName(sourceRoot,dependencyRoot,actual);
        if(!path)throw new Error("RT dependency outside declared source/dependency roots");
        const bytes=observed.get(path)??readFileSync(actual);if(!Buffer.from(bytes.toString("utf8")).equals(bytes))throw new Error("Non-UTF8 RT compiler input");
        observed.set(path,bytes);
        return {contents:bytes.toString("utf8"),loader:actual.endsWith(".json")?"json":actual.endsWith(".ts")?"ts":"js",resolveDir:dirname(actual)};
      });
    }}]});
  if(result.outputFiles.length!==1||Object.values(result.metafile.outputs).some(output=>output.imports.length))throw new Error("RT replay module must be self-contained: "+JSON.stringify(Object.values(result.metafile.outputs).flatMap(output=>output.imports)));
  if(observed.size!==Object.keys(result.metafile.inputs).length)throw new Error("Unobserved RT compiler inputs");
  const module=Buffer.from(result.outputFiles[0].contents),sources=[...observed].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,bytes])=>({path,sha256:sha(bytes)}));
  const manifest={format:"ptn-rt-envelope-module",version:1,moduleSha256:sha(module),sources,compiler:{esbuild:esbuild.version,options},rebuild:"compiler/resolver installation not fully retained"};
  mkdirSync(destination,{mode:0o700});mkdirSync(join(destination,"sources"),{mode:0o700});writeFileSync(join(destination,"module.mjs"),module,{flag:"wx",mode:0o400});
  const written=new Set();for(const row of sources)if(!written.has(row.sha256)){writeFileSync(join(destination,"sources",row.sha256),observed.get(row.path),{flag:"wx",mode:0o400});written.add(row.sha256);}
  writeFileSync(join(destination,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});return manifest;
}
