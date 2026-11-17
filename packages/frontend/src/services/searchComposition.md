# Post-planner walking composition capture

`SearchConfig.compositionCapture` is an optional synchronous local observer.
It records the live `SearchOrchestrator` path after planner output and direct-walk
candidate construction. Normal searches do not create records or serialize data.
Existing `finalizationCapture` observers remain supported independently or together.

Version 1 records contain the ordered raw planner itineraries, entry/exit walks
and physical distances, departure seconds, stop locations, rider walking speed,
supplied direct-walking candidate, ranking/limit/minimum transfer, and ordered
transfer pedestrian requests/responses. A null route is distinct from typed
transient/superseded graph unavailability. Successful records include the nested
RT finalization capture and complete returned results. Provider errors other
than the declared unavailability type propagate rather than becoming empty paths.

`replaySearchComposition(record)` re-runs transfer walking evidence and itinerary
composition from the recorded pedestrian responses. It checks request arguments,
order and exhaustion, then verifies the recomposed input against the nested
finalization record before replaying frozen-clock RT feasibility/ranking. It
does not call a live pedestrian or RT provider. Changed walking evidence,
composition or output rejects replay. Original planner ordering, duplicates and
per-pair pedestrian request dedup remain observable.

Records are frozen independent finite JSON-wire data with a 2 MiB serialized
record limit. Oversized/non-finite requested captures reject, never truncate.
Observers are synchronous; collect the record and handle asynchronous persistence
outside the observer. Requested synchronous observer failures propagate. Empty
planner/no-reachable-stop outcomes are captured too and make no transfer routing
request. These records can contain precise locations and trip IDs; there is no
automatic storage, upload or user-facing capture activation.

This is still a **partial capture**. Endpoint/direct-walk construction before
planner output, planner/timetable execution artifacts, raw pedestrian graph and
route execution, pre-lookup RT feeds and original producer module/runtime
identity are not established by the record. Pedestrian responses are observations,
not an independent physical-reachability oracle. Use the retained replay-module
tooling for local artifact integrity and compatible-code replay; it does not
upgrade those missing dependencies or establish a historical reproduction.
