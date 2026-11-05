// H53c page: one session runs one build in a fresh module worker. For each
// tuple it sends one first request, then warmups, then measured requests.
// A request is the two-stage sequence (latest-departure, then portfolio).
// The page keeps timings and digests only; result objects are dropped.
export const SAMPLE_KINDS = ["first", "warmup", "measured"];

export function sampleKind(rep, warmup) {
  return rep === 0 ? "first" : rep <= warmup ? "warmup" : "measured";
}

export function validateSessionInput(x) {
  const ok = x && typeof x.build === "string" && typeof x.workerUrl === "string"
    && typeof x.glueUrl === "string" && typeof x.wasmUrl === "string"
    && Array.isArray(x.tuples) && x.tuples.length > 0 && Array.isArray(x.goals) && x.goals.length > 0
    && Number.isSafeInteger(x.iterations) && x.iterations >= 1 && Number.isSafeInteger(x.warmup) && x.warmup >= 0
    && x.options && typeof x.options === "object" && Number.isSafeInteger(x.maxRounds)
    && (x.window == null || (Number.isSafeInteger(x.window.start) && Number.isSafeInteger(x.window.end) && x.window.start < x.window.end))
    && (x.reverse == null || typeof x.reverse === "boolean") && !(x.reverse && x.window);
  if (!ok) throw Error("invalid profile session input");
}

export async function runProfileSession(input) {
  validateSessionInput(input);
  const visibility = [];
  const onVisibility = () => visibility.push(document.visibilityState);
  document.addEventListener("visibilitychange", onVisibility);
  const worker = new Worker(input.workerUrl, { type: "module" });
  let serial = 0, pending = null;
  const rpc = (message) => new Promise((resolve, reject) => {
    if (pending) { reject(Error("overlapping profile request")); return; }
    const id = ++serial, sentEpochMs = performance.timeOrigin + performance.now();
    const timer = setTimeout(() => { pending = null; reject(Error(`profile worker timeout: ${message.type}`)); }, 300000);
    pending = { id, sentEpochMs, stages: [], resolve: (v) => { clearTimeout(timer); pending = null; resolve(v); },
      reject: (e) => { clearTimeout(timer); pending = null; reject(e); } };
    worker.postMessage({ ...message, id });
  });
  worker.onerror = (e) => pending?.reject(Error(e.message || "profile worker error"));
  worker.onmessage = ({ data: m }) => {
    if (!pending || pending.id !== m.id) { pending?.reject(Error("stale or unsolicited worker output")); return; }
    if (m.phase === "fatal") { pending.reject(Error(m.error)); return; }
    if (m.phase === "stage") {
      const receivedEpochMs = performance.timeOrigin + performance.now();
      const { result, workerEndEpochMs, ...timing } = m.value; // Received like a UI would; not kept.
      pending.stages.push({ ...timing, resultDelivered: result !== null,
        pageMs: receivedEpochMs - pending.sentEpochMs, deliveryMs: receivedEpochMs - workerEndEpochMs });
      return;
    }
    if (m.phase !== "done") { pending.reject(Error(`unknown worker phase ${m.phase}`)); return; }
    pending.resolve(pending.stages.length ? { stages: pending.stages, ...m.value } : m.value);
  };
  const began = new Date().toISOString(), samples = [];
  let load, free;
  try {
    load = await rpc({ type: "load", glueUrl: input.glueUrl, wasmUrl: input.wasmUrl, ptbUrl: input.ptbUrl,
      ptftUrl: input.ptftUrl, patternMode: input.patternMode });
    const reps = 1 + input.warmup + input.iterations;
    for (const [tupleIndex, tuple] of input.tuples.entries()) {
      for (let rep = 0; rep < reps; rep++) {
        const query = { ...tuple, maxRounds: input.maxRounds };
        // H70: the window is built before the request, outside its timing.
        const window = input.window
          ? await rpc({ type: "window", query, start: input.window.start, end: input.window.end }) : null;
        // H58: `reverse` finds the latest departure by the backward scan first.
        const v = await rpc({ type: "sequence", query, options: input.options, goals: input.goals, suffix: input.suffix,
          reverse: input.reverse === true });
        samples.push({ tupleIndex, rep, kind: sampleKind(rep, input.warmup), ...v, ...(window ? { window } : {}) });
      }
    }
    free = await rpc({ type: "free" });
  } finally {
    worker.terminate();
    document.removeEventListener("visibilitychange", onVisibility);
  }
  return { build: input.build, began, ended: new Date().toISOString(), load, free, samples,
    visibilityChanges: visibility, visibilityAfter: document.visibilityState };
}
