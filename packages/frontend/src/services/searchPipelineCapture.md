# Linked search stage observations

`SearchConfig.pipelineCapture` is an optional synchronous local observer, absent
from normal product configuration. A successful `search()` call emits one
immutable `ptn-search-pipeline` version 1 record. Its scope is **frontend linked
stages with observed planner** and its classification remains partial capture.

The record joins the received coordinates, query clock/settings, entry and exit
reach observations, accepted direct pedestrian response, exact planner invocation
query/service date and returned ordering, walking composition, frozen RT reads,
and final returned output. Each search owns its collector; overlapping calls do
not replace shared observers. Existing independent observers still receive their
records. Planner arguments are copied before awaiting the planner. An injected
planner is labelled `injected`; this does not itself prove remote provenance.

No-reach searches explicitly record `planner: null`. A successful empty planner
response is an invocation with `output: []`. Planner/provider/observer errors
propagate and do not emit a successful pipeline record. Error/timeout execution
capture is not supported at this frontend boundary. The finite JSON wire format
and combined 2 MiB limit apply to the whole record; oversized opt-in capture fails
explicitly rather than truncating a stage.

`replaySearchPipeline` recomputes reach, direct walking and post-planner walking,
RT feasibility and ranking against retained observations. It checks direction,
coordinates/stop groups, ordered stop geometry, mobility/pace/budgets, reach to
planner/composition walks, planner to composition output, ranking/limits and final
output. Nested stage replays check provider lookup argument order and exhaustion.
The capsule CLI in `tools/search-finalization` supports retention and replay.

Planner execution and its timetable/feed/module artifacts are still missing.
The observed service-date/time-frame resolution and active services are retained
as planner inputs, not independently recomputed. Upstream endpoint selection,
readiness waiting, raw pedestrian graphs/provider execution, pre-lookup RT feeds,
and original application bytes/runtime are also outside this boundary. A linked
record proves stage continuity under observed responses; it does not establish
full search reproducibility, independent physical feasibility or human quality.

Precise coordinates and trip IDs can be present. Keep these diagnostics local
unless a user explicitly authorizes export. Nothing uploads records automatically.
