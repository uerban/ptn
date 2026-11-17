import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const [modulePath,recordPath,moduleHash,recordHash]=process.argv.slice(1);
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const moduleBytes=readFileSync(modulePath),recordBytes=readFileSync(recordPath);
if(digest(moduleBytes)!==moduleHash||digest(recordBytes)!==recordHash)throw new Error("Materialized replay artifact changed");
// Import the observed module bytes, not a second read of its pathname.
const module=await import(`data:text/javascript;base64,${moduleBytes.toString("base64")}`);
const output=module.replayFinalization(JSON.parse(recordBytes));
process.stdout.write(JSON.stringify({completion:"success",moduleHash,recordHash,output})+"\n");
