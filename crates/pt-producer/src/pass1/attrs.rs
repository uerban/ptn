// Pass-1 attribute structures.
//
// Captured during the per-feed CSV scans before the interners are
// finalized; the attribute vectors are indexed by the interner's
// PRE-finalize id (insertion order). `run_pass1_union` remaps them to
// POST-finalize ids by walking each interner's `remap()` table.
// Cross-references stored inside a struct (e.g. `TripAttrs::route_idx`)
// are also pre-finalize ids and are remapped through the *target*
// interner's `remap()` table — see `finalize_remap_preserves_attribute_alignment`
// for the canary test.

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StopAttrs {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// GTFS stops.wheelchair_boarding 0/1/2, 0 = no info/missing.
    pub wheelchair_boarding: u8,
    /// GTFS stops.parent_station — raw stop_id reference (PRE-finalize, like all
    /// other String fields here). Empty string = no parent. Resolved to a
    /// post-finalize stop_idx after `stops.finalize()` and emitted as part of
    /// `Pass1Result.stop_parent_map`. Stops whose parent_station references an
    /// unknown stop_id (typo in feed) get logged + dropped; pass1 does not abort.
    pub parent_station: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RouteAttrs {
    pub agency_id: String,
    pub short_name: String,
    pub long_name: String,
    pub route_type: u16,
    /// GTFS routes.route_color — 6-hex RGB string (e.g. "FF0000"), empty if absent.
    pub route_color: String,
    /// GTFS routes.route_text_color — 6-hex RGB string (e.g. "FFFFFF"), empty if absent.
    pub route_text_color: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TripAttrs {
    /// Pre-finalize during the CSV scan; rewritten to post-finalize
    /// at the end of `run_pass1_union` via `routes.remap()`.
    pub route_idx: u32,
    /// Same contract as `route_idx`, but against the services interner.
    pub service_idx: u32,
    pub headsign: String,
    /// GTFS trips.wheelchair_accessible 0/1/2.
    pub wheelchair_accessible: u8,
    /// GTFS trips.direction_id — `0` (outbound), `1` (inbound), or `0xFF`
    /// (absent / blank / any other value). `0xFF` is the "no direction"
    /// sentinel and maps to `undefined` on the network path's tri-state
    /// (see `parser.ts`). Use `parse_direction_id` to produce this value.
    pub direction_id: u8,
    /// GTFS trips.bikes_allowed 0/1/2 (0 = no info). Written to trip byte +18.
    pub bikes_allowed: u8,
    /// GTFS trips.shape_id — empty string if absent.
    pub shape_id: String,
    /// GTFS trips.txt block_id — empty string when absent.
    /// Build-time only; NOT written to the PTB Trip record (no format change).
    /// Used to derive transfer_type=4 (in-seat) rules from block-chained trips.
    /// GTFS reference: https://gtfs.org/documentation/schedule/reference/#tripstxt
    pub block_id: String,
    /// Rank (0-based position in the feed list) of the component feed whose
    /// `trips.txt` row defined this trip (first feed wins). Scopes PTB v2
    /// block keys so equal `block_id` text in two feeds never merges vehicles.
    pub feed_rank: u32,
}

/// Place each entry in `pre` at the post-finalize position given by `remap`.
/// `pre.len() == remap.len()` invariant — both equal the interner's count.
pub fn remap_attrs<T: Default + Clone>(pre: Vec<T>, remap: &[u32]) -> Vec<T> {
    assert_eq!(
        pre.len(),
        remap.len(),
        "attrs vector length mismatched with interner remap; \
         a CSV scan extended the interner without pushing an attrs entry"
    );
    let n = pre.len();
    let mut post: Vec<T> = vec![T::default(); n];
    for (pre_id, item) in pre.into_iter().enumerate() {
        let post_id = remap[pre_id] as usize;
        post[post_id] = item;
    }
    post
}
