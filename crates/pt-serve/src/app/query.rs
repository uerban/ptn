//! Shared `application/x-www-form-urlencoded` component decoding for
//! `app::*` and `http::*` query-string parsing.
//!
//! This is form-encoding, NOT full URI percent-decoding: `+` decodes to a
//! space in addition to `%HH` escapes. Callers that need duplicate-key
//! handling, a per-key size limit, or a richer error type wrap this in their
//! own `query_param` (see `app::address_search` and `http::server`, which
//! intentionally differ on duplicate-key policy and are not merged here).

/// Error returned when a form-urlencoded component cannot be decoded within
/// the caller's byte limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeFormError;

/// Decodes one form-urlencoded component (a single query key or value).
/// Errors if the input exceeds `max_decoded_bytes` (checked both pre- and
/// post-decode, pre-check bounds the allocation before any decode work) or
/// contains a malformed `%` escape.
pub fn decode_form_component(
    raw: &str,
    max_decoded_bytes: usize,
) -> Result<String, DecodeFormError> {
    if raw.len() > max_decoded_bytes.saturating_mul(3) {
        return Err(DecodeFormError);
    }

    let mut form_bytes = Vec::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                form_bytes.push(b' ');
                index += 1;
            }
            b'%' => {
                let Some(encoded) = bytes.get(index + 1..index + 3) else {
                    return Err(DecodeFormError);
                };
                if !encoded.iter().all(u8::is_ascii_hexdigit) {
                    return Err(DecodeFormError);
                }
                form_bytes.extend_from_slice(&bytes[index..index + 3]);
                index += 3;
            }
            byte => {
                form_bytes.push(byte);
                index += 1;
            }
        }
    }

    let decoded = percent_encoding::percent_decode(&form_bytes)
        .decode_utf8()
        .map_err(|_| DecodeFormError)?;
    if decoded.len() > max_decoded_bytes {
        return Err(DecodeFormError);
    }

    Ok(decoded.into_owned())
}
