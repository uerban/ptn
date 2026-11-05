//! Structured resource limits for H62. Unknown/integrity errors carry no tag.
use super::*;

fn query_limit(error: &DeadlineError) -> Option<&'static str> {
    match error {
        DeadlineError::SegmentsExhausted { .. } => Some("segments"),
        DeadlineError::FrontierExhausted { .. } => Some("frontier"),
        DeadlineError::StopScansExhausted { .. } => Some("stop-scans"),
        DeadlineError::OptimisticEdgesExhausted { .. } => Some("optimistic-edges"),
        DeadlineError::Lookup(LazyLookupError::WorkExhausted { .. }) => Some("lookup-work"),
        _ => None,
    }
}

fn prepare_limit(error: &DeadlineSessionPrepareError) -> Option<&'static str> {
    match error {
        DeadlineSessionPrepareError::Request(error) => query_limit(error),
        DeadlineSessionPrepareError::Catalogue(error) => match error {
            TransferIndexError::EventsExhausted { .. } => Some("catalogue-events"),
            TransferIndexError::EdgesExhausted { .. } => Some("catalogue-edges"),
            TransferIndexError::BytesExhausted { .. } => Some("catalogue-bytes"),
            _ => None,
        },
    }
}

fn tagged(message: String, limit: Option<&str>) -> JsValue {
    let error = js_sys::Error::new(&message);
    if let Some(limit) = limit {
        // If adding metadata ever fails, the caller sees an unclassified error
        // and clears the prior result. Never infer recoverability from text.
        let _ = js_sys::Reflect::set(error.as_ref(), &"ptnResourceLimit".into(), &limit.into());
    }
    error.into()
}

pub(super) fn prepare(error: DeadlineSessionPrepareError) -> JsValue {
    tagged(
        format!("deadline preparation: {error:?}"),
        prepare_limit(&error),
    )
}

pub(super) fn query(error: DeadlineError, movements: bool) -> JsValue {
    let stage = if movements { "journey" } else { "query" };
    tagged(
        format!("deadline winner {stage}: {error:?}"),
        query_limit(&error),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_resource_variants_are_recoverable() {
        let cases = [
            (
                DeadlineError::SegmentsExhausted {
                    limit: 1,
                    attempted: 2,
                },
                "segments",
            ),
            (
                DeadlineError::FrontierExhausted {
                    limit: 1,
                    attempted: 2,
                },
                "frontier",
            ),
            (
                DeadlineError::StopScansExhausted {
                    limit: 1,
                    attempted: 2,
                },
                "stop-scans",
            ),
            (
                DeadlineError::OptimisticEdgesExhausted {
                    limit: 1,
                    attempted: 2,
                },
                "optimistic-edges",
            ),
            (
                DeadlineError::Lookup(LazyLookupError::WorkExhausted {
                    limit: 1,
                    attempted: 2,
                }),
                "lookup-work",
            ),
        ];
        for (error, name) in cases {
            assert_eq!(query_limit(&error), Some(name));
            assert_eq!(
                prepare_limit(&DeadlineSessionPrepareError::Request(error)),
                Some(name)
            );
        }
        for (error, name) in [
            (
                TransferIndexError::EventsExhausted {
                    limit: 1,
                    attempted: 2,
                },
                "catalogue-events",
            ),
            (
                TransferIndexError::EdgesExhausted {
                    limit: 1,
                    attempted: 2,
                },
                "catalogue-edges",
            ),
            (
                TransferIndexError::BytesExhausted {
                    limit: 1,
                    attempted: 2,
                },
                "catalogue-bytes",
            ),
        ] {
            assert_eq!(
                prepare_limit(&DeadlineSessionPrepareError::Catalogue(error)),
                Some(name)
            );
        }
        for error in [
            DeadlineError::BindingMismatch,
            DeadlineError::InvalidRequest("WorkExhausted"),
            DeadlineError::Engine(pt_core::EngineError::Corrupt("SegmentsExhausted")),
            DeadlineError::Lookup(LazyLookupError::BindingMismatch),
        ] {
            assert_eq!(query_limit(&error), None);
        }
        assert_eq!(
            prepare_limit(&DeadlineSessionPrepareError::Catalogue(
                TransferIndexError::InvalidConfig("BytesExhausted")
            )),
            None
        );
    }
}
