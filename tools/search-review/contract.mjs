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

export function validateReviewStopContext(context,ptbSha256) {
  if(context?.format!=="ptn-search-review-stop-context" || context.version!==1
      || context.derivation!=="pt-core-reader-e7-name-v1" || context.ptbSha256!==ptbSha256
      || !Array.isArray(context.stops) || context.stops.length>50000) fail("invalid stop context provenance");
  const ids=new Set();
  for(const stop of context.stops) {
    if(!stop || typeof stop.stopId!=="string" || !stop.stopId || stop.stopId.length>1000 || ids.has(stop.stopId)
        || typeof stop.name!=="string" || stop.name.length>1000
        || !Number.isInteger(stop.latE7) || Math.abs(stop.latE7)>900000000
        || !Number.isInteger(stop.lonE7) || Math.abs(stop.lonE7)>1800000000) fail("invalid stop context row");
    ids.add(stop.stopId);
  }
  return context;
}

export async function validateReviewBundle(bundle) {
  if(bundle?.format==="ptn-search-review-bundle" && bundle.version===2) {
    const expected=await createReviewComparison(bundle.comparison?.before,bundle.comparison?.after);
    if(JSON.stringify(canonical(bundle))!==JSON.stringify(canonical(expected))) fail("comparison derivation or identity mismatch");
    return bundle;
  }
  if (bundle?.format !== "ptn-search-review-bundle" || bundle.version !== 1
      || bundle.scope !== "stop-level compiled engine") fail("unsupported format or scope");
  const p = bundle.provenance;
  if (!p || !digest(p.snapshotId) || !digest(p.runManifestSha256)
      || !["controlled snapshot","partial capture"].includes(p.classification)
      || typeof p.replayVerification !== "string"
      || !strings(p.missingDependencies) || !strings(p.unsupported)) fail("missing provenance");
  if (!p.artifacts || !Object.values(p.artifacts).every(digest)
      || !["ptb","queryTuples","glue","wasm"].every(name => digest(p.artifacts[name]))) fail("missing artifact hashes");
  if(p.executionContract!==undefined && !["snapshot-data-url-v1","file-url-v0"].includes(p.executionContract)) fail("unsupported execution contract");
  if(bundle.stopContext!==undefined) {
    if(!digest(p.artifacts.reviewStopContext)) fail("missing stop context artifact");
    validateReviewStopContext(bundle.stopContext,p.artifacts.ptb);
  }
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

/** A derived blind-review view. Source bundles preserve every rank/duplicate;
 * source identity participates in candidate identity, even for equal itineraries.
 * The primary provenance/snapshot is explicitly the before source. */
export async function createReviewComparison(before,after) {
  if(before?.version!==1 || after?.version!==1) fail("comparison requires two single-capture bundles");
  await validateReviewBundle(before);await validateReviewBundle(after);
  const a=before.provenance,b=after.provenance;
  const same=(x,y)=>JSON.stringify(canonical(x))===JSON.stringify(canonical(y));
  const execution=p=>p.executionContract;
  const supported=["snapshot-data-url-v1","file-url-v0"];
  if(a.artifacts.ptb!==b.artifacts.ptb || a.artifacts.queryTuples!==b.artifacts.queryTuples
      || !same(a.settings,b.settings) || !supported.includes(execution(a)) || execution(a)!==execution(b)) fail("incomparable inputs, settings or execution contract");
  if(!["node","v8","platform","arch","release"].every(key=>a.runtime[key]===b.runtime[key])) fail("incomparable runtime");
  if(before.cases.length!==after.cases.length) fail("incomparable query count");
  const cases=[];
  for(const [index,left] of before.cases.entries()) {
    const right=after.cases[index];
    if(!same(left.query,right.query)) fail("incomparable query");
    const id=left.id,candidates=[];
    for(const [side,row] of [["before",left],["after",right]]) {
      for(const [rank,candidate] of row.candidates.entries()) {
        const source={side,rank,caseId:row.id,candidateId:candidate.id};
        candidates.push({id:await fingerprint({caseId:id,itinerary:candidate.itinerary,source}),
          itinerary:structuredClone(candidate.itinerary),source});
      }
    }
    cases.push({id,query:structuredClone(left.query),candidates,
      capture:{...structuredClone(left.capture),truncated:left.capture.truncated||right.capture.truncated},
      comparisonStatus:same(left.candidates.map(c=>c.itinerary),right.candidates.map(c=>c.itinerary))?"unchanged":"changed/unreviewed"});
  }
  const content={format:"ptn-search-review-bundle",version:2,scope:before.scope,
    provenance:structuredClone(a),comparison:{primarySource:"before",before:structuredClone(before),after:structuredClone(after)},cases,
    ...(before.stopContext?{stopContext:structuredClone(before.stopContext)}:{})};
  return {...content,bundleId:await fingerprint(content)};
}
