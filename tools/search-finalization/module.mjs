import {createRequire} from "node:module";
import {readFileSync,mkdirSync,writeFileSync,realpathSync} from "node:fs";
import {resolve,relative,join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";

export const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
export const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../..");

/** The compiler receives exactly the bytes retained by onLoad, rather than a
 * second filesystem read. The output module, not future recompilation, is the
 * replay authority; compiler/resolver installation is not fully retained. */
export async function buildFinalizationModule(destination,inputRoot=sourceRoot) {
  const root=realpathSync(resolve(inputRoot));
  const require=createRequire(realpathSync(fileURLToPath(new URL("../../packages/frontend/node_modules/vite/package.json",import.meta.url))));
  const esbuild=require("esbuild"),observed=new Map();
  const sharedSources={
    "@pt/shared/constants":"packages/shared/src/constants/index.ts",
    "@pt/shared/time":"packages/shared/src/time/timeDomain.ts",
    "@pt/shared/routing":"packages/shared/src/routing/index.ts",
    "@pt/shared/util":"packages/shared/src/util/index.ts",
  };
  const options={bundle:true,platform:"node",format:"esm",target:"node22",treeShaking:true,
    tsconfigRaw:{compilerOptions:{target:"ES2022",useDefineForClassFields:true}}};
  const result=await esbuild.build({...options,absWorkingDir:root,
    entryPoints:["packages/frontend/src/services/searchReplay.ts"],write:false,metafile:true,
    plugins:[{name:"retained-source-bytes",setup(build){
      build.onResolve({filter:/^@pt\/shared(?:\/.*)?$/},args=>{
        if(!Object.hasOwn(sharedSources,args.path))throw new Error(`Undeclared shared source dependency: ${args.path}`);
        return {path:resolve(root,sharedSources[args.path])};
      });
      build.onLoad({filter:/\.(?:tsx?|m?js|json)$/},args=>{
        const name=relative(root,args.path);
        if(name.startsWith("..")||name.startsWith("/"))throw new Error("Replay module dependency is outside source root");
        const bytes=observed.get(name)??readFileSync(args.path);
        if(!Buffer.from(bytes.toString("utf8")).equals(bytes))throw new Error("Compiler input is not UTF-8");
        observed.set(name,bytes);
        const extension=args.path.split(".").at(-1);
        return {contents:bytes.toString("utf8"),loader:extension==="json"?"json":extension==="tsx"?"tsx":extension==="ts"?"ts":"js",resolveDir:dirname(args.path)};
      });
    }}]});
  if(result.outputFiles.length!==1||Object.values(result.metafile.outputs).some(output=>output.imports.length))throw new Error("Replay module must be self-contained");
  for(const name of Object.keys(result.metafile.inputs))if(!observed.has(name))throw new Error(`Unobserved compiler input: ${name}`);
  const module=Buffer.from(result.outputFiles[0].contents);
  const sources=[...observed].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,bytes])=>({path,sha256:sha(bytes)}));
  const manifest={format:"ptn-search-finalization-module",version:1,moduleSha256:sha(module),sources,
    recordFormats:["ptn-search-finalization","ptn-search-composition","ptn-search-reach","ptn-search-pipeline"],
    compiler:{esbuild:esbuild.version,options,sharedSources},buildReproducibility:"compiler/resolver installation not fully retained"};
  mkdirSync(destination,{mode:0o700});mkdirSync(join(destination,"sources"),{mode:0o700});
  writeFileSync(join(destination,"module.mjs"),module,{flag:"wx",mode:0o400});
  const written=new Set();
  for(const {path,sha256} of sources)if(!written.has(sha256)){writeFileSync(join(destination,"sources",sha256),observed.get(path),{flag:"wx",mode:0o400});written.add(sha256);}
  writeFileSync(join(destination,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
  return manifest;
}
