//! Opt-in setup attribution (H67): a `performance.now()` timestamp at each
//! owner-construction and `prepare` marker. Built only with the
//! `temporal-setup-profile` feature; production builds never enable it.
//! The buffer is preallocated, so recording allocates nothing.
use super::now;
use pt_core::engine::temporal_probe::trip_based::DeadlineSetupPhase;
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy)]
pub(super) enum Mark {
    Wasm(&'static str),
    Core(DeadlineSetupPhase),
}

const CAPACITY: usize = 64;

struct Marks {
    marks: Vec<(Mark, f64)>,
    overflowed: bool,
}

thread_local! {
    static MARKS: RefCell<Marks> = RefCell::new(Marks {
        marks: Vec::with_capacity(CAPACITY),
        overflowed: false,
    });
}

pub(super) fn mark(mark: Mark) {
    let at = now();
    MARKS.with(|m| {
        let mut m = m.borrow_mut();
        if m.marks.len() < CAPACITY {
            m.marks.push((mark, at));
        } else {
            m.overflowed = true;
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkWire {
    phase: String,
    at_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileWire {
    marks: Vec<MarkWire>,
    overflowed: bool,
}

/// Returns and clears the recorded markers. Call it outside timed intervals.
#[wasm_bindgen(js_name = takeSetupProfile)]
pub fn take_setup_profile() -> Result<JsValue, JsError> {
    let wire = MARKS.with(|m| {
        let mut m = m.borrow_mut();
        let marks = m
            .marks
            .drain(..)
            .map(|(mark, at_ms)| MarkWire {
                phase: match mark {
                    Mark::Wasm(name) => name.to_owned(),
                    Mark::Core(phase) => format!("{phase:?}"),
                },
                at_ms,
            })
            .collect();
        ProfileWire {
            marks,
            overflowed: std::mem::take(&mut m.overflowed),
        }
    });
    serde_wasm_bindgen::to_value(&wire).map_err(|e| JsError::new(&format!("setup profile: {e}")))
}
