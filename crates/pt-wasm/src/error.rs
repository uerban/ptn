//! `PtbError`/`EngineError` → `JsError` mapping.
//!
//! `pt-core` returns `Result` everywhere (no panics on bad input — master
//! ). The host translates the internal error to a `JsError` whose
//! `message` carries enough detail for the JS-side caller to branch.

use pt_core::PtbError;
use wasm_bindgen::prelude::*;

pub fn ptb_error_to_js(err: PtbError) -> JsError {
    // PtbError implements Display; the message is the wire format
    // (see pt-core/src/error.rs — every variant has an actionable string).
    JsError::new(&format!("pt-core reader error: {}", err))
}
