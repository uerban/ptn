#!/usr/bin/env node
// Generate a private signing key once. Re-run the builder configuration to
// refresh the same catalog; do not generate a new key for every update.
import {generateKeyPairSync, createPrivateKey, createPublicKey} from "node:crypto";
import {readFileSync, mkdirSync, writeFileSync, existsSync} from "node:fs";
import {resolve} from "node:path";

const root = resolve(import.meta.dirname, "../..");
if (!process.argv[2]) throw new Error("usage: node examples/native/prepare-osm.mjs <build-directory>");
const work = resolve(process.argv[2]);
mkdirSync(work, {recursive: true, mode: 0o700});
const keyPath = resolve(work, "signing-key.pem");
if (!existsSync(keyPath)) {
  const {privateKey} = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({type: "pkcs8", format: "pem"}), {mode: 0o600, flag: "wx"});
}
const privateKey = createPrivateKey(readFileSync(keyPath));
const publicKey = createPublicKey(privateKey).export({type: "spki", format: "der"}).subarray(-32).toString("hex");
const revision = JSON.parse(readFileSync(resolve(root, "release.json"), "utf8")).revision;
const config = {
  cities: ["vilnius"], workDir: resolve(work, "work"), repository: resolve(work, "repository"),
  signingKey: keyPath, trustedKeys: [publicKey], revision, cityTimeoutMs: 3600000,
  producer: resolve(root, "bin/pt-producer"), walkBuilder: resolve(root, "bin/pt-walk-build"),
  publisher: resolve(root, "bin/pt-artifact-publish"),
};
writeFileSync(resolve(work, "builder.json"), JSON.stringify(config, null, 2) + "\n");
writeFileSync(resolve(work, "artifact-source.json"), JSON.stringify({
  artifactSource: {kind: "local", directory: config.repository}, trustedKeys: [publicKey],
}, null, 2) + "\n");
console.log(`Builder configuration: ${resolve(work, "builder.json")}`);
console.log(`Public source configuration: ${resolve(work, "artifact-source.json")}`);
