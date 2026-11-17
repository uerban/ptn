# Local search finalization capture

`SearchConfig.finalizationCapture` is an optional local diagnostic observer.
Ordinary searches do not create records, serialize candidates, store files or
upload anything. A caller can explicitly collect successful finalization records:

```ts
const records: FinalizationCapture[] = [];
const orchestrator = new SearchOrchestrator({
  ...config,
  finalizationCapture: record => records.push(record),
});
```

Each frozen record retains the composed transit inputs, supplied direct-walking
candidate and geometry, minimum transfer, ranking, result limit, finalization
clock, ordered RT/transfer-floor lookup arguments and returned values, and the
complete returned array. Repeated lookups remain separate observations even
when their trip IDs match. Empty successful outcomes are records too. Errors
before finalization are outside this format.

`replayFinalization(JSON.parse(savedJson))` executes only RT overlay, feasibility,
ranking and limiting against those observations. It uses the recorded freshness
clock, performs no provider/graph/store lookup, and rejects changed lookup order,
arguments, counts or output fields. Serialize with `JSON.stringify(record)`.
Version 1 compares finite JSON-wire values, ignoring object property order;
optional undefined object fields are absent, while array holes, executable
values and non-finite numbers reject. A complete serialized record is limited to
2 MiB and is rejected rather than truncated. This is a record-size limit, not a
process-memory quota. Requested capture/observer failures propagate to the
requesting caller rather than claiming that evidence was saved.

This is explicitly a **partial capture** of `frontend RT feasibility and ranking`.
It does not retain application/runtime module bytes, upstream endpoint reach or
planner execution, raw pedestrian graphs/route execution, or raw RT feeds before
lookup. It can replay already-supplied walking evidence; it cannot rebuild a
pedestrian route. It does not reproduce a complete search, establish independent
feasibility, or verify evidence authenticity. Replay requires compatible
finalization code; retain its source/runtime provenance with persisted records.

The observer receives independent frozen JSON data, so later caller mutations
cannot rewrite it. Persistence, content hashing, immutable artifact retention,
user-facing export and sharing are separate responsibilities. Records can contain
precise locations and trip identifiers. Keep them local unless sharing is
explicitly requested. The format does not promote baselines or turn replay
equality into a usefulness judgment.
