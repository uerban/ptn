// Portable contract shared by the local exporter and browser reviewer.
export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  throw new Error("Review data must contain only finite JSON values");
}
export async function fingerprint(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
}
const fail = message => { throw new Error(`Invalid review bundle: ${message}`); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");

export async function validateReviewBundle(bundle) {
  if (bundle?.format !== "ptn-search-review-bundle" || bundle.version !== 1
      || bundle.scope !== "stop-level compiled engine") fail("unsupported format or scope");
  const p = bundle.provenance;
  if (!p || !digest(p.snapshotId) || !digest(p.runManifestSha256)
      || !["controlled snapshot","partial capture"].includes(p.classification)
      || typeof p.replayVerification !== "string"
      || !strings(p.missingDependencies) || !strings(p.unsupported)) fail("missing provenance");
  if (!p.artifacts || !Object.values(p.artifacts).every(digest)
      || !["ptb","queryTuples","glue","wasm"].every(name => digest(p.artifacts[name]))) fail("missing artifact hashes");
  if (!["node","v8","platform","arch","release"].every(name => typeof p.runtime?.[name] === "string" && p.runtime[name].trim())) fail("missing runtime");
  const s = p.settings;
  if (s?.patternMode !== "covering-merge" || !["plan","r3","m4"].includes(s.objective)) fail("unsupported planning settings");
  if (s.objective === "plan" ? s.windowStart !== null || s.windowEnd !== null
      : !Number.isSafeInteger(s.windowStart) || s.windowStart < 0 || !Number.isSafeInteger(s.windowEnd) || s.windowEnd <= s.windowStart) fail("invalid planning window");
  if (p.snapshotId !== await fingerprint({artifacts:p.artifacts,runtime:p.runtime,settings:p.settings})) fail("snapshot identity mismatch");
  if (!Array.isArray(bundle.cases)) fail("missing cases");
  for (const [index, row] of bundle.cases.entries()) {
    if (!row || !row.query || typeof row.query !== "object" || Array.isArray(row.query)
        || !Array.isArray(row.candidates) || row.capture?.boundary !== "stop-level engine"
        || row.capture.equivalence !== "exact" || typeof row.capture.truncated !== "boolean") fail("invalid case");
    if (row.id !== await fingerprint({snapshotId:p.snapshotId,query:row.query,index})) fail("case identity mismatch");
    for (const candidate of row.candidates) {
      if (!candidate?.itinerary || !Array.isArray(candidate.itinerary.legs)) fail("invalid itinerary");
      if (candidate.id !== await fingerprint({caseId:row.id,itinerary:candidate.itinerary})) fail("candidate identity mismatch");
    }
  }
  const {bundleId,...content} = bundle;
  if (!digest(bundleId) || bundleId !== await fingerprint(content)) fail("bundle identity mismatch");
  return bundle;
}
