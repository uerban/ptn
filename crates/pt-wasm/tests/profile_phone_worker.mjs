// H53c worker (H53d, H67, H70, H58): one deadline build per worker. A request is the two-stage
// product sequence: prepare once, run latest-departure and send it, then run
// portfolio (all four) and send it. Each result goes to the page in its timed
// stage message, as a UI would receive it. Result digests are computed and
// sent afterwards, outside every timed interval.
export const TIMING_KEYS = ["prepareMs", "searchMs", "coreMs", "movementMs"];

// Same canonical form the host applies to the pinned reference rows.
export function canonicalResult(result) {
  const copy = { ...result };
  for (const key of TIMING_KEYS) delete copy[key];
  return JSON.stringify(copy);
}

// H58: the answer of a winner request without its window echo, work counters
// or diagnostics, so a one-second request compares with the full one.
export const WINNER_KEYS = ["scope", "contract", "complete", "completionScope", "queryKind", "suffixBound",
  "arrivalDeadline", "winners", "journeyContract", "journeys", "journeyByPreference"];
export function canonicalWinner(result) {
  for (const key of WINNER_KEYS) if (!(key in result)) throw Error(`winner result has no ${key}`);
  return JSON.stringify(Object.fromEntries(WINNER_KEYS.map((k) => [k, result[k]])));
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw Error(`fetch ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function createProfileHost({ send, importGlue = (url) => import(url) }) {
  let pkg = null, wasmExports = null, probe = null;
  const memoryBytes = () => wasmExports?.memory?.buffer?.byteLength ?? null;

  async function load({ glueUrl, wasmUrl, ptbUrl, ptftUrl, patternMode }) {
    if (probe) throw Error("profile worker already owns a probe");
    const f0 = performance.now();
    const [glue, wasm, ptb, ptft] = await Promise.all([glueUrl, wasmUrl, ptbUrl, ptftUrl].map(fetchBytes));
    const fetchMs = performance.now() - f0;
    const c0 = performance.now();
    const module = await WebAssembly.compile(wasm);
    const compileMs = performance.now() - c0;
    const g0 = performance.now();
    pkg = await importGlue(glueUrl);
    const glueImportMs = performance.now() - g0;
    const i0 = performance.now();
    wasmExports = pkg.initSync({ module });
    const instantiateMs = performance.now() - i0;
    const o0 = performance.now();
    probe = pkg.TemporalDeadlineProbe.withImmutableBinding(ptb, ptft, patternMode);
    const ownerMs = performance.now() - o0;
    // Profile builds (H67) export their setup markers; read after timing.
    const ownerProfile = pkg.takeSetupProfile ? pkg.takeSetupProfile() : null;
    return {
      fetchMs, compileMs, glueImportMs, instantiateMs, ownerMs, ownerProfile,
      glueSha256: await sha256(glue), wasmSha256: await sha256(wasm),
      ptbSha256: await sha256(ptb), ptftSha256: await sha256(ptft),
      wasmBytes: wasm.byteLength, memoryBytesAfterOwner: memoryBytes(),
    };
  }

  // Returns the results so the digests can be taken after the last stage.
  // H58 `reverse`: the backward scan finds the latest departure D, the first
  // goal (latest-departure) runs on [D, D + 1), then the rest on the full
  // window. Without D (no journey, or out of the scan's scope) the request
  // continues as the normal sequence, with the scan inside its timing.
  function sequence(id, { query, options, goals, suffix, reverse = false }) {
    if (!probe) throw Error("profile worker has no probe");
    const results = [];
    const t0 = performance.now();
    const stage = (goal, { result, error, failedAt, prepareMs, runMs, end, scan = null }) => {
      const engine = result ? Object.fromEntries(TIMING_KEYS.map((k) => [k, result[k] ?? null])) : null;
      send({ id, phase: "stage", value: {
        goal, status: error ? "failed" : "completed", stage: error ? failedAt : null, error,
        prepareMs, runMs, elapsedMs: end - t0, workerEndEpochMs: performance.timeOrigin + end, engine, result,
        ...(reverse && goal === goals[0] ? { scan } : {}),
      } });
      results.push([goal, result]);
      return !error;
    };
    let rest = goals, scan = null;
    if (reverse) {
      if (goals[0] !== "latest-departure") throw Error("reverse needs latest-departure first");
      if (typeof probe.latestDeparture !== "function") throw Error("build has no latestDeparture");
      const r0 = performance.now();
      let wire = null, error = null;
      try { wire = probe.latestDeparture(query, options.windowStart, options.windowEnd, options.arrivalDeadline); } catch (e) { error = String(e); }
      const r1 = performance.now();
      scan = { scanMs: r1 - r0, wire, narrowed: false };
      if (error) { stage(goals[0], { result: null, error, failedAt: "scan", prepareMs: null, runMs: null, end: r1, scan }); return results; }
      if (wire.departure !== null && wire.outOfScope === null) {
        scan.narrowed = true;
        let result = null, failedAt = null;
        try { probe.prepare(query, { ...options, windowStart: wire.departure, windowEnd: wire.departure + 1 }); } catch (e) { error = String(e); failedAt = "prepare"; }
        const p1 = performance.now();
        if (!error) try { result = probe.run_winner_journeys(goals[0], suffix); } catch (e) { error = String(e); failedAt = "run"; }
        const s1 = performance.now();
        if (!stage(goals[0], { result, error, failedAt, prepareMs: p1 - r1, runMs: error && failedAt === "prepare" ? null : s1 - p1, end: s1, scan })) return results;
        rest = goals.slice(1);
      }
    }
    const f0 = performance.now();
    let prepareError = null;
    try { probe.prepare(query, options); } catch (e) { prepareError = String(e); }
    const t1 = performance.now();
    for (const goal of rest) {
      let result = null, error = prepareError;
      const s0 = performance.now();
      if (!prepareError) try { result = probe.run_winner_journeys(goal, suffix); } catch (e) { error = String(e); }
      const s1 = performance.now();
      const ok = stage(goal, { result, error, failedAt: prepareError ? "prepare" : "run", prepareMs: t1 - f0,
        runMs: prepareError ? null : s1 - s0, end: s1, scan });
      if (!ok) break;
    }
    return results;
  }

  // H70: hold a window catalogue ahead of the next request, timed on its own.
  function prepareWindow({ query, start, end }) {
    if (!probe) throw Error("profile worker has no probe");
    if (typeof probe.prepareWindow !== "function") throw Error("build has no prepareWindow");
    const w0 = performance.now();
    const wire = probe.prepareWindow(query, start, end);
    const windowMs = performance.now() - w0;
    return { windowMs, wire, profile: pkg.takeSetupProfile ? pkg.takeSetupProfile() : null, memoryBytes: memoryBytes() };
  }

  return async function handle(message) {
    const { id, type } = message;
    if (type === "load") {
      send({ id, phase: "done", value: await load(message) });
    } else if (type === "sequence") {
      const results = sequence(id, message);
      const setupProfile = pkg.takeSetupProfile ? pkg.takeSetupProfile() : null;
      const digests = {}, winnerDigests = {};
      const digest = (text) => sha256(new TextEncoder().encode(text));
      for (const [goal, result] of results) {
        digests[goal] = result ? await digest(canonicalResult(result)) : null;
        if (message.reverse) winnerDigests[goal] = result ? await digest(canonicalWinner(result)) : null;
      }
      send({ id, phase: "done", value: { digests, ...(message.reverse ? { winnerDigests } : {}), memoryBytes: memoryBytes(), setupProfile } });
    } else if (type === "window") {
      send({ id, phase: "done", value: prepareWindow(message) });
    } else if (type === "free") {
      const f0 = performance.now();
      probe?.free();
      probe = null;
      send({ id, phase: "done", value: { freeMs: performance.now() - f0, memoryBytesHighWater: memoryBytes() } });
    } else {
      throw Error(`unknown profile worker message: ${type}`);
    }
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof document === "undefined") {
  const handle = createProfileHost({ send: (m) => self.postMessage(m) });
  self.onmessage = ({ data }) => {
    void handle(data).catch((error) => self.postMessage({ id: data.id, phase: "fatal", error: String(error) }));
  };
}
