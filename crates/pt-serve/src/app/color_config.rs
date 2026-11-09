//! `GET /api/<city>/color-config` — verbatim producer-emitted color-config.json.
use crate::app::response::{ByteBody, Resp};
use crate::bundle::Generation;
use std::sync::Arc;

pub fn color_config(gen: &Generation) -> Resp {
    match gen.color_config.as_ref() {
        Some(bytes) => Resp::CachedBytes {
            status: 200,
            body: ByteBody::Raw(Arc::clone(bytes)),
            content_type: "application/json",
            cache_control: "public, max-age=86400",
            etag: None, // backend sets no ETag on /color-config
            gzipped: false,
        },
        // Byte-identical to the Node backend's 503 body.
        None => Resp::Json {
            status: 503,
            body: "{\"error\":\"Color config not yet computed\"}".to_string(),
        },
    }
}
