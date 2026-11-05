# pt-serve test fixtures

Generated at test time (not committed as binary) by hand-mutating a known-good
`tiny.ptb` from `packages/shared/src/ptb/__fixtures__/`. See
`tests/reload_index_build.rs` for the fixture-building helper.

## Corrupt `service_idx` bundle (generated in a tempdir)

Structurally-valid PTB bytes whose trip 0 (`0xF2 TripsIntern` record,
`service_idx u32 @+12`) references a service equal to `num_services`. The
structural validator (which re-uses `Reader::from_bytes`) accepts the bytes —
the Reader checks region bounds, CSR shape, the service pool and the string
pool, not per-trip service ordinals — but `Index::build` rejects it with
`EngineError::Corrupt("trip.service_idx >= num_services")`, which the shared
builder maps to `ValidationError::Engine`.

This is the load-bearing test for Engine-class routing: the reload
runner must classify Index-build failures distinctly from structural
failures so operators can alert differently on producer corruption (which
the structural validator would catch) versus engine-build refusal (which
implies a producer that emitted internally-inconsistent records — same
class of action but a different production signal).
