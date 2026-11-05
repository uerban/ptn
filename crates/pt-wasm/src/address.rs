//! `PtAddressIndex` — the browser half of local address search.
//!
//! The packed artifact IS the index, so this binding lets the browser query it
//! directly out of the bytes it fetched: no parse, no client-side rebuild, and
//! nothing kept in IndexedDB but the bytes themselves.
//!
//! Query normalization lives in `pt_geocode`, the same code pt-serve runs.
//! Browser and server share this one implementation, so a query typed
//! offline resolves exactly as it would online.

use pt_geocode::AddrIndex;
use serde::Serialize;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// One search result, serialized to the shape `AddressSearchGeocoderAdapter`
/// consumes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hit {
    label: String,
    lat: f64,
    lon: f64,
    row_id: usize,
    matched_key: String,
    /// True when the matched key is exactly one of the query's normalized
    /// variants rather than a longer key it prefixes. The adapter scores on
    /// this; computing it here keeps the two planes agreeing on what "exact"
    /// means.
    exact: bool,
}

#[wasm_bindgen]
pub struct PtAddressIndex {
    index: AddrIndex,
}

#[wasm_bindgen]
impl PtAddressIndex {
    /// Load a packed address artifact (`PTAS`, schema version 1).
    ///
    /// `buf` is copied once, into an `Arc` the index then reads in place — the
    /// JS-side `ArrayBuffer` is not retained, so the caller may drop it.
    #[wasm_bindgen(constructor)]
    pub fn new(buf: &[u8]) -> Result<PtAddressIndex, JsError> {
        let bytes: Arc<[u8]> = Arc::from(buf.to_vec());
        let index = AddrIndex::from_bytes(bytes)
            .map_err(|e| JsError::new(&format!("address artifact rejected: {e}")))?;
        Ok(PtAddressIndex { index })
    }

    /// Number of display rows the artifact carries.
    #[wasm_bindgen(js_name = rowCount)]
    pub fn row_count(&self) -> usize {
        self.index.row_count()
    }

    /// Number of distinct keys in the FST.
    #[wasm_bindgen(js_name = keyCount)]
    pub fn key_count(&self) -> usize {
        self.index.key_count()
    }

    /// Bytes of the FST section — what the index actually occupies, as opposed
    /// to the whole artifact.
    #[wasm_bindgen(js_name = fstSizeBytes)]
    pub fn fst_size_bytes(&self) -> usize {
        self.index.size_bytes()
    }

    /// The city this corpus was built for, if it recorded one.
    #[wasm_bindgen(js_name = cityId)]
    pub fn city_id(&self) -> Option<String> {
        self.index.meta().city_id.clone()
    }

    /// Search, returning at most `limit` hits as a JS array.
    ///
    /// Normalization and the query-variant expansion (synonyms, stemming, the
    /// Slavic term-first rotation) happen inside `pt_geocode` — the caller
    /// passes the raw text the user typed.
    #[wasm_bindgen]
    pub fn search(&self, query: &str, limit: usize) -> Result<JsValue, JsError> {
        let variants = pt_geocode::address_search_query_variants(query);
        if variants.is_empty() {
            return serde_wasm_bindgen::to_value(&Vec::<Hit>::new())
                .map_err(|e| JsError::new(&e.to_string()));
        }
        let hits: Vec<Hit> = self
            .index
            .prefix_search_any(variants.iter().map(String::as_str), limit)
            .into_iter()
            .map(|m| Hit {
                exact: variants.contains(&m.key),
                label: m.label,
                lat: m.lat,
                lon: m.lon,
                row_id: m.row_id,
                matched_key: m.key,
            })
            .collect();
        serde_wasm_bindgen::to_value(&hits).map_err(|e| JsError::new(&e.to_string()))
    }

    /// The normalized variants a query expands to. Exposed for diagnostics and
    /// for the response `meta.queryVariants` the server sends, so an offline
    /// result can be explained the same way an online one is.
    #[wasm_bindgen(js_name = queryVariants)]
    pub fn query_variants(query: &str) -> Result<JsValue, JsError> {
        serde_wasm_bindgen::to_value(&pt_geocode::address_search_query_variants(query))
            .map_err(|e| JsError::new(&e.to_string()))
    }
}
