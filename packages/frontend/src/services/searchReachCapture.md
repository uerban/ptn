# Reachable-stop observations

`SearchConfig.reachCapture` is an optional synchronous local observer. Each
successful entry or exit calculation emits a separate immutable
`ptn-search-reach` version 1 record. The observer is absent in normal product
configuration. The record contains precise coordinates; callers must keep it
local unless the user explicitly authorizes an export.

Records preserve the ordered stop universe, effective input options and mobility
profile, OSRM readiness, directed table arguments and responses, transfer lookup
arguments and values (including missing values), and the complete ordered reach
output. Repeated lookup reads remain separate. Provider errors propagate without
emitting a successful record. Observer errors also propagate.

`replayReachableStops(record)` runs the same reach calculation against the
recorded provider responses. It checks lookup order, arguments, consumption and
ordered output. It does not consult live providers or download a graph. The
finite JSON wire format rejects non-finite observations and limits each record
to 2 MiB; an oversized opt-in capture fails explicitly.

This is a partial observation boundary. It excludes endpoint selection and the
preceding OSRM readiness wait, raw provider modules/graphs and transfer table
artifacts, planner execution, and original application/runtime identity. It does
not prove that provider responses were physically correct. The existing retained
finalization/composition capsule CLI does not yet accept this record format.
