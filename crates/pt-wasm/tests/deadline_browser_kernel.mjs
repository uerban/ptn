// Shared isolated browser/worker kernel. Not an application planner adapter.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function percentile(samples, fraction) {
  if (!samples.length) throw new Error("empty timing sample");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function checkWalking(result,prepared,options,expected) {
  if(result.walkingBound!==options.walkingBound||prepared.walkingBound!==options.walkingBound) throw new Error("wrong walking bound mode");
  if(!expected) return; // Legacy native references have no walking diagnostics.
  const actual=result.prefixWalking;
  // Vec headers depend on pointer width: compare semantic counters, and
  // validate/report each target's footprint rather than equating byte sizes.
  if(actual?.enabled!==expected.enabled||actual?.prunedBoardings!==expected.prunedBoardings
      ||!Number.isSafeInteger(actual?.bytes)||actual.bytes<0||(actual.enabled?actual.bytes===0:actual.bytes!==0)) {
    throw new Error("wrong walking bound diagnostics");
  }
}

function checkForward(result,prepared,options,expected) {
  if(result.forwardSeeds!==options.forwardSeeds||prepared.forwardSeeds!==options.forwardSeeds) throw new Error("wrong forward seed mode");
  if(!expected) return;
  const actual=result.forward;
  if(!actual||Object.keys(expected).filter(k=>k!=="arenaBytes").some(k=>actual[k]!==expected[k])
      ||!Number.isSafeInteger(actual.arenaBytes)||actual.arenaBytes<0) throw new Error("wrong forward seed diagnostics");
}

function checkLookup(result,prepared,options,expected) {
  if(result.witnessComparison!==options.witnessComparison||prepared.witnessComparison!==options.witnessComparison)
    throw new Error("wrong witness comparison mode");
  if(result.lookupMode!==options.lookup||prepared.lookupMode!==options.lookup) throw new Error("wrong lookup mode");
  if(!expected) return;
  const actual=result.lazy;
  if(!actual||Object.keys(expected).filter(k=>k!=="sourceBoundCacheBytes").some(k=>actual[k]!==expected[k]))
    throw new Error("wrong native lookup diagnostics");
  const cacheKeys=["sourceBoundCacheRows","sourceBoundCacheProbes","sourceBoundCacheHits","sourceBoundCacheMisses","sourceBoundCacheBytes"];
  const workKeys=["eventProbes","pairChecks","instanceProbes","walkingIndexEdges","ruleCandidateEdges"];
  if([...cacheKeys,...workKeys].some(k=>!Number.isSafeInteger(actual[k])||actual[k]<0)
      ||actual.sourceBoundCacheProbes!==actual.sourceBoundCacheHits+actual.sourceBoundCacheMisses
      ||actual.sourceBoundCacheBytes<actual.sourceBoundCacheRows*16||actual.sourceBoundCacheBytes>actual.sourceBoundCacheRows*32
      ||options.lookup==="lazy-fast"&&cacheKeys.some(k=>actual[k]!==0)
      ||actual.work!==workKeys.reduce((n,k)=>n+actual[k],0)+actual.sourceBoundCacheRows+actual.sourceBoundCacheProbes
        +actual.sourceBoundCacheMisses+(result.forward?.lookupWork??0)
      ||actual.work!==result.lookupWork||actual.pairChecks!==result.pairChecks
      ||actual.work>options.maxLookupWork) throw new Error("wrong lookup cache accounting");
}

function searchWork(result) {
  return Object.fromEntries(["segmentsEnqueued","stopEventsScanned","pairChecks","lookupWork"].map(k=>[k,result[k]]));
}
function checkSearch(result,expected) {
  if(expected&&Object.entries(expected).some(([k,v])=>!Number.isSafeInteger(result[k])||result[k]<0||result[k]!==v))
    throw new Error("wrong native search counters");
}

export function checkFrontierStats(f,{storage,pointerBytes,eventCount,segmentsEnqueued},expected) {
  const count=n=>Number.isSafeInteger(n)&&n>=0,indexed=storage==="event-indexed";
  const fields=["directoryEntries","directoryCapacityBytes","records","recordCapacityBytes","retainedIds","idCapacityBytes"];
  if(!["tree","event-indexed"].includes(storage)||pointerBytes!==4||!count(eventCount)||!count(segmentsEnqueued)
      ||!f||canonical(Object.keys(f).sort())!==canonical([...fields].sort())
      ||fields.filter(k=>k!=="recordCapacityBytes").some(k=>!count(f[k]))
      ||f.records>eventCount||f.retainedIds<f.records||f.retainedIds>segmentsEnqueued
      ||f.directoryEntries!==(indexed?eventCount:0)||f.directoryCapacityBytes!==f.directoryEntries*pointerBytes
      ||f.idCapacityBytes<f.retainedIds*pointerBytes||f.idCapacityBytes%pointerBytes!==0
      ||(indexed?(!count(f.recordCapacityBytes)||f.recordCapacityBytes<f.records*3*pointerBytes
        ||f.recordCapacityBytes%(3*pointerBytes)!==0):f.recordCapacityBytes!==null)
      ||expected&&(f.records!==expected.records||f.retainedIds!==expected.retainedIds||eventCount!==expected.eventCount))
    throw Error("wrong frontier capacity/count diagnostics");
}
function checkFrontiers(result,prepared,options,expected) {
  if(result.frontierStorage!==options.frontierStorage||prepared.frontierStorage!==options.frontierStorage)
    throw Error("wrong frontier storage mode");
  checkFrontierStats(result.frontiers,{storage:options.frontierStorage,pointerBytes:result.pointerBytes,
    eventCount:prepared.eventCount,segmentsEnqueued:result.segmentsEnqueued},expected);
}

export async function runDeadlineCases(input, hooks = {}) {
  const validationMode = input.validationMode ?? "checked";
  const catalogueMode = input.catalogueMode ?? "fresh";
  const workload = input.workload ?? "runs";
  if (!input.tuples?.length || input.expectedPoints?.length !== input.tuples.length
      || !Number.isSafeInteger(input.iterations) || input.iterations < 1
      || !Number.isSafeInteger(input.warmup) || input.warmup < 0
      || !["checked","session"].includes(validationMode) || !["fresh","reuse"].includes(catalogueMode)
      || !["runs","requests"].includes(workload)) throw new Error("invalid or empty browser workload");
  const options = { lookup:"lazy-fast", witnessComparison:"materialized", frontierStorage:"tree", traversal:"fifo", staticBound:false, walkingBound:false, forwardSeeds:false, prefixBound:true, pointBound:true,
    ...input.options, validation:validationMode, catalogue:catalogueMode };
  if(!["materialized","streaming"].includes(options.witnessComparison))throw new Error("invalid witness comparison mode");
  if(options.witnessComparison==="streaming"&&!input.expectedSearch)throw new Error("missing native search counters");
  if(!["tree","event-indexed"].includes(options.frontierStorage))throw Error("invalid frontier storage mode");
  if(options.frontierStorage==="event-indexed"&&(!input.expectedSearch||input.expectedFrontiers?.length!==input.tuples.length))
    throw Error("missing native frontier/search diagnostics");
  if(!["lazy-fast","lazy-cached"].includes(options.lookup)||options.lookup==="lazy-cached"&&!input.expectedLazy)
    throw new Error("invalid lookup or missing native cache diagnostics");
  if (!["fifo","arrival-first","guided"].includes(options.traversal) || typeof options.staticBound!=="boolean"
      ||options.traversal==="guided"&&!options.staticBound) throw new Error("invalid traversal/static bound mode");
  if(typeof options.walkingBound!=="boolean"||options.walkingBound&&(!options.prefixBound||!options.pointBound)) throw new Error("invalid walking bound mode");
  if(typeof options.forwardSeeds!=="boolean"||options.forwardSeeds&&(!options.prefixBound||!options.pointBound)) throw new Error("invalid forward seed mode");
  const fetchBytes = hooks.fetchBytes ?? (async (url) => {
    const response = await fetch(url); if (!response.ok) throw new Error(`input HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  });
  const loadModule = hooks.loadModule ?? ((url) => import(url));
  const started = performance.now();
  const pkg = await loadModule("/pt_wasm.js");
  if (typeof pkg.TemporalDeadlineProbe !== "function") throw new Error("experimental deadline export missing");
  const [wasmBytes, ptb, ptft] = await Promise.all([fetchBytes("/pt_wasm_bg.wasm"), fetchBytes("/bundle.ptb"), fetchBytes("/transfers.bin")]);
  const exports = await pkg.default({ module_or_path: wasmBytes });
  const moduleLoadMs = performance.now() - started;
  const initialLinearBytes = exports.memory.buffer.byteLength;
  const began = performance.now();
  const probe = new pkg.TemporalDeadlineProbe(ptb, ptft, input.patternMode);
  const constructorMs = performance.now() - began;
  const afterConstructorLinearBytes = exports.memory.buffer.byteLength;
  const rows = [];
  let boundaryChecksPassed = false;
  try {
    if (input.verifyBoundary) {
      const rejects = (label, operation, pattern) => {
        let caught = false;
        try { operation(); } catch (error) { if (!pattern.test(String(error))) throw error; caught=true; }
        if (!caught) throw new Error(`expected boundary rejection missing: ${label}`);
      };
      const q = { ...input.tuples[0], maxRounds:input.maxRounds };
      rejects("unprepared run",() => probe.run(), /not prepared/);
      probe.prepare(q,options);
      rejects("unknown option",() => probe.prepare(q,{...options,unexpectedField:1}), /options/);
      rejects("stale prior catalogue",() => probe.run(), /not prepared/);
      rejects("unknown validation",() => probe.prepare(q,{...options,validation:"unsupported"}), /options/);
      rejects("stale rejected validation",() => probe.run(), /not prepared/);
      rejects("unknown catalogue",() => probe.prepare(q,{...options,catalogue:"unsupported"}), /options/);
      rejects("stale rejected catalogue",() => probe.run(), /not prepared/);
      rejects("unknown traversal",() => probe.prepare(q,{...options,traversal:"beam"}), /options/);
      rejects("stale rejected traversal",() => probe.run(), /not prepared/);
      rejects("unknown lookup",() => probe.prepare(q,{...options,lookup:"lazy-cache"}), /options/);
      rejects("stale rejected lookup",() => probe.run(), /not prepared/);
      rejects("unknown witness comparison",() => probe.prepare(q,{...options,witnessComparison:"stream"}), /options/);
      rejects("stale rejected comparison",() => probe.run(), /not prepared/);
      rejects("unknown frontier storage",() => probe.prepare(q,{...options,frontierStorage:"indexed"}), /options/);
      rejects("stale rejected frontier storage",() => probe.run(), /not prepared/);
      rejects("invalid static bound",() => probe.prepare(q,{...options,staticBound:"yes"}), /options/);
      rejects("stale rejected static bound",() => probe.run(), /not prepared/);
      rejects("invalid walking bound",() => probe.prepare(q,{...options,walkingBound:"yes"}), /options/);
      rejects("stale rejected walking bound",() => probe.run(), /not prepared/);
      rejects("invalid forward seeds",() => probe.prepare(q,{...options,forwardSeeds:"yes"}), /options/);
      rejects("stale rejected forward seeds",() => probe.run(), /not prepared/);
      probe.prepare(q,{...options,maxLookupWork:1});
      rejects("work cap",() => probe.run(), /WorkExhausted/);
      const mutableQuery = structuredClone(q), mutableOptions = structuredClone(options);
      probe.prepare(mutableQuery,mutableOptions);
      const before = probe.run();
      mutableQuery.maxRounds = 0; mutableOptions.maxLookupWork = 1; mutableOptions.traversal = "beam"; mutableOptions.staticBound=!options.staticBound;
      mutableOptions.walkingBound=!options.walkingBound;
      mutableOptions.forwardSeeds=!options.forwardSeeds;
      mutableOptions.lookup=options.lookup==="lazy-fast"?"lazy-cached":"lazy-fast";
      mutableOptions.witnessComparison=options.witnessComparison==="materialized"?"streaming":"materialized";
      mutableOptions.frontierStorage=options.frontierStorage==="tree"?"event-indexed":"tree";
      const after = probe.run();
      if (canonical(before.points) !== canonical(after.points) || after.validationMode !== validationMode || after.staticBound!==before.staticBound
          ||after.walkingBound!==before.walkingBound||after.forwardSeeds!==before.forwardSeeds||after.lookupMode!==before.lookupMode
          ||after.witnessComparison!==before.witnessComparison||after.frontierStorage!==before.frontierStorage)
        throw new Error("caller mutation altered prepared session");
      probe.prepare({...q,maxRounds:0},options);
      if (probe.run().points.length) throw new Error("reprepare reused old request");
      probe.clear();
      rejects("cleared catalogue",() => probe.run(), /not prepared/);
      boundaryChecksPassed = true;
    }
    if (workload === "requests") {
      probe.clear(); // Charge the first catalogue and every subsequent key miss.
      const result = runChangingRequests(probe,exports,input,options);
      return { ...result,validationMode,catalogueMode,workload,moduleLoadMs,constructorMs,
        initialLinearBytes,afterConstructorLinearBytes,finalLinearBytes:exports.memory.buffer.byteLength,boundaryChecksPassed };
    }
    for (let index = 0; index < input.tuples.length; index++) {
      const query = { ...input.tuples[index], maxRounds: input.maxRounds };
      const want = canonical(input.expectedPoints[index]);
      let prepared;
      const beforeCatalogueLinearBytes = exports.memory.buffer.byteLength;
      const began = performance.now();
      try { prepared = probe.prepare(query, options); }
      catch (error) { rows.push({ tupleIndex:index,status:"failed",stage:"prepare",error:String(error) }); continue; }
      const catalogueMs = performance.now() - began;
      const afterCatalogueLinearBytes = exports.memory.buffer.byteLength;
      const execute = () => {
        const began = performance.now(); const result = probe.run(); const ms = performance.now() - began;
        if (!result.complete || result.scope !== "deadline-constrained-r3-m4-experiment") throw new Error("incomplete or wrong-scope result");
        if (result.validationMode !== validationMode) throw new Error("wrong validation mode");
        if (result.traversalMode !== options.traversal || prepared.traversalMode !== options.traversal) throw new Error("wrong traversal mode");
        if (result.staticBound !== options.staticBound || prepared.staticBound !== options.staticBound) throw new Error("wrong static bound mode");
        checkWalking(result,prepared,options,input.expectedWalking?.[index]);
        checkForward(result,prepared,options,input.expectedForward?.[index]);
        checkLookup(result,prepared,options,input.expectedLazy?.[index]);
        checkSearch(result,input.expectedSearch?.[index]);
        checkFrontiers(result,prepared,options,input.expectedFrontiers?.[index]);
        if (canonical(result.points) !== want) throw new Error("full canonical native/WASM mismatch");
        return { result, ms };
      };
      try {
        const firstQueryMs = execute().ms; // Canonical preflight, outside repeated samples.
        for (let n = 0; n < input.warmup; n++) execute();
        const calls=[], prepare=[], search=[];
        const beforeTimedLinearBytes = exports.memory.buffer.byteLength;
        let last;
        for (let n = 0; n < input.iterations; n++) {
          const { result, ms } = execute(); last=result;
          calls.push(ms); prepare.push(result.prepareMs); search.push(result.searchMs);
        }
        rows.push({ tupleIndex:index,status:"completed",parity:"full-native-canonical-equal",complete:true,
          pointCount:last.points.length,points:last.points,
          validationMode,catalogueMs,firstQueryMs,catalogueAndFirstQueryMs:catalogueMs+firstQueryMs,
          p50Ms:percentile(calls,.5),p95Ms:percentile(calls,.95),
          samplesMs:calls,
          prepareSamplesMs:prepare,searchSamplesMs:search,
          prepareP95Ms:percentile(prepare,.95),searchP95Ms:percentile(search,.95),
          beforeCatalogueLinearBytes,afterCatalogueLinearBytes,beforeTimedLinearBytes,
          afterTimedLinearBytes:exports.memory.buffer.byteLength,eventIndex:prepared,
          work:last.lookupWork,pairChecks:last.pairChecks,segmentsEnqueued:last.segmentsEnqueued,
          prefixEnabled:last.prefixEnabled,stopIndexed:last.stopIndexed,lookupMode:last.lookupMode,witnessComparison:last.witnessComparison,
          frontierStorage:last.frontierStorage,pointerBytes:last.pointerBytes,frontiers:last.frontiers,lazy:last.lazy,searchWork:searchWork(last) });
      } catch (error) { rows.push({ tupleIndex:index,status:"failed",stage:"query",error:String(error) }); }
      probe.clear();
    }
  } finally { probe.free(); }
  return { status:rows.every((r) => r.status === "completed") ? "completed" : "failed",
    validationMode,catalogueMode,workload,moduleLoadMs,constructorMs,initialLinearBytes,afterConstructorLinearBytes,
    finalLinearBytes:exports.memory.buffer.byteLength,boundaryChecksPassed,queries:rows };
}

// Whole sweeps alternate actual query tuples; each timed sample prepares a new
// request before running. No per-tuple clear hides cache lifetime or date misses.
function runChangingRequests(probe,exports,input,options) {
  if (input.expectedKeys?.length !== input.tuples.length
      || input.expectedKeys.some(k=>!Array.isArray(k)||k.length!==32||k.some(x=>!Number.isInteger(x)||x<0||x>255))) throw new Error("native catalogue keys missing");
  const data=input.tuples.map(()=>({total:[],prepare:[],run:[],corePrepare:[],search:[],hits:0,misses:0}));
  const batch=[];
  let lastKey=null;
  for(let sweep=0;sweep<1+input.warmup+input.iterations;sweep++) {
    const timed=sweep>input.warmup;
    let sum=0;
    for(let i=0;i<input.tuples.length;i++) {
      try {
        const d=data[i];
        if(sweep===input.warmup+1) d.beforeTimedLinearBytes=exports.memory.buffer.byteLength;
        const key=canonical(input.expectedKeys[i]),want=canonical(input.expectedPoints[i]);
        const query={...input.tuples[i],maxRounds:input.maxRounds};
        const began=performance.now();
        const prepared=probe.prepare(query,options);
        const at=performance.now();
        const result=probe.run();
        const ended=performance.now();
        const totalMs=ended-began,prepareMs=at-began,runMs=ended-at;
        // Every correctness/key check is outside the measured intervals.
        if([result.prepareMs,result.searchMs].some(t=>!Number.isFinite(t)||t<0))throw Error("invalid core phase timing");
        const hit=options.catalogue==="reuse"&&lastKey===key;
        if(prepared.catalogueMode!==options.catalogue || prepared.catalogueReused!==hit
            ||canonical(prepared.catalogueKey)!==key) throw new Error("catalogue identity/hit mismatch");
        if(!result.complete||result.scope!=="deadline-constrained-r3-m4-experiment"
            ||result.validationMode!==options.validation||result.traversalMode!==options.traversal
            ||prepared.traversalMode!==options.traversal||result.staticBound!==options.staticBound
            ||prepared.staticBound!==options.staticBound||canonical(result.points)!==want) throw new Error("full native request parity/mode mismatch");
        checkWalking(result,prepared,options,input.expectedWalking?.[i]);
        checkForward(result,prepared,options,input.expectedForward?.[i]);
        checkLookup(result,prepared,options,input.expectedLazy?.[i]);
        checkSearch(result,input.expectedSearch?.[i]);
        checkFrontiers(result,prepared,options,input.expectedFrontiers?.[i]);
        lastKey=key;
        if(sweep===0) { d.firstRequestMs=totalMs;d.firstCatalogueMs=prepareMs;d.firstCatalogueReused=hit;d.eventIndex=prepared; }
        if(timed) {d.total.push(totalMs);d.prepare.push(prepareMs);d.run.push(runMs);d.corePrepare.push(result.prepareMs);d.search.push(result.searchMs);d.hits+=+hit;d.misses+=+!hit;sum+=totalMs;d.last=result;d.afterTimedLinearBytes=exports.memory.buffer.byteLength;}
      } catch(error) { return {status:"failed",queries:[{tupleIndex:i,status:"failed",stage:"request",error:String(error)}]}; }
    }
    if(timed) batch.push(sum);
  }
  return {status:"completed",batchP50Ms:percentile(batch,.5),batchP95Ms:percentile(batch,.95),
    batchTimingScope:"sum of prepare+run timings; native parity/key checks excluded",
    queries:data.map((d,i)=>({tupleIndex:i,status:"completed",complete:true,parity:"full-native-canonical-equal",
      pointCount:d.last.points.length,points:d.last.points,p50Ms:percentile(d.total,.5),p95Ms:percentile(d.total,.95),
      samplesMs:d.total,catalogueSamplesMs:d.prepare,runSamplesMs:d.run,
      prepareSamplesMs:d.corePrepare,searchSamplesMs:d.search,
      catalogueP95Ms:percentile(d.prepare,.95),runP95Ms:percentile(d.run,.95),firstRequestMs:d.firstRequestMs,
      firstCatalogueMs:d.firstCatalogueMs,firstCatalogueReused:d.firstCatalogueReused,cacheHits:d.hits,cacheMisses:d.misses,
      eventIndex:d.eventIndex,beforeTimedLinearBytes:d.beforeTimedLinearBytes,afterTimedLinearBytes:d.afterTimedLinearBytes,
      work:d.last.lookupWork,pairChecks:d.last.pairChecks,segmentsEnqueued:d.last.segmentsEnqueued,
      prefixEnabled:d.last.prefixEnabled,stopIndexed:d.last.stopIndexed,lookupMode:d.last.lookupMode,witnessComparison:d.last.witnessComparison,
      frontierStorage:d.last.frontierStorage,pointerBytes:d.last.pointerBytes,frontiers:d.last.frontiers,lazy:d.last.lazy,searchWork:searchWork(d.last),
      optimistic:d.last.optimistic,prefixWalking:d.last.prefixWalking,forward:d.last.forward}))};
}
