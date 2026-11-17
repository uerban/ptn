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
process-memory quota. Observers are synchronous; collect the record and perform
asynchronous persistence separately. Requested synchronous capture/observer failures propagate to the
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

When a floor provider and explicit state getter are supplied, capture records the
applied stop/route/trip rule maps immediately before synchronous finalization.
`floorRules` is an optional v1 extension. Entries retain opaque keys, raw values,
insertion order, and absent versus empty maps. Orchestrator diagnostic capture
supplies this getter; ordinary searches do not copy rule maps.

Replay restores the tables and recomputes every observed floor answer through
production `effectiveTransferFloor`, including null/zero/fallback semantics. It
rejects a state/answer mismatch, malformed or duplicate entries, and rules without
a floor provider. Legacy observations without the extension keep transcript-only
behavior. The full record still obeys the 2 MiB finite-wire limit. Applied table
capture does not prove original GTFS/bundle/index provenance or browser identity.
