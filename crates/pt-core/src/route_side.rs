//! `0x23 RouteSideTable`: optional cold route metadata and GTFS networks.
//!
//! Layout is specified in `docs/ptb-region-ids.md` §6. Routing never reads this
//! region, so hosts decode it on demand and malformed data cannot block a bundle.

use alloc::vec::Vec;

/// The only layout this decoder understands.
pub const ROUTE_SIDE_TABLE_VERSION: u16 = 1;
/// Marks an absent `sort_order` or `network_ord`.
pub const ROUTE_SIDE_ABSENT: u32 = u32::MAX;

const HEADER_BYTES: usize = 16;
const NETWORK_COLUMNS: usize = 2;
const ROUTE_COLUMNS: usize = 4;

/// One route's optional fields. String indices use 0 (empty string) for absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteSideRow {
    pub desc_idx: u32,
    pub url_idx: u32,
    pub sort_order: Option<u32>,
    pub network_ord: Option<u32>,
}

/// Why a version 1 region was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteSideError {
    Truncated,
    ReservedNonZero,
    RouteCountMismatch,
    LengthMismatch,
    StringIndexOutOfRange,
    NetworkOrdinalOutOfRange,
}

/// Validated view over a version 1 region body.
#[derive(Debug, Clone, Copy)]
pub struct RouteSideTable<'a> {
    body: &'a [u8],
    network_count: usize,
    route_count: usize,
}

fn u32_at(body: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        body[offset],
        body[offset + 1],
        body[offset + 2],
        body[offset + 3],
    ])
}

impl<'a> RouteSideTable<'a> {
    /// Decode a region body. `Ok(None)` means a newer version this reader skips.
    pub fn decode(
        body: &'a [u8],
        num_routes: u32,
        string_count: u32,
    ) -> Result<Option<Self>, RouteSideError> {
        if body.len() < 2 {
            return Err(RouteSideError::Truncated);
        }
        if u16::from_le_bytes([body[0], body[1]]) != ROUTE_SIDE_TABLE_VERSION {
            return Ok(None);
        }
        if body.len() < HEADER_BYTES {
            return Err(RouteSideError::Truncated);
        }
        if body[2..4] != [0, 0] || u32_at(body, 12) != 0 {
            return Err(RouteSideError::ReservedNonZero);
        }
        let route_count = u32_at(body, 4);
        if route_count != num_routes {
            return Err(RouteSideError::RouteCountMismatch);
        }
        let network_count = u32_at(body, 8) as usize;
        let route_count = route_count as usize;
        let expected = network_count
            .checked_mul(NETWORK_COLUMNS * 4)
            .and_then(|n| n.checked_add(route_count.checked_mul(ROUTE_COLUMNS * 4)?))
            .and_then(|n| n.checked_add(HEADER_BYTES));
        if expected != Some(body.len()) {
            return Err(RouteSideError::LengthMismatch);
        }
        let table = Self {
            body,
            network_count,
            route_count,
        };
        table.validate(string_count)?;
        Ok(Some(table))
    }

    fn validate(&self, string_count: u32) -> Result<(), RouteSideError> {
        let string = |idx: u32| {
            if idx < string_count {
                Ok(())
            } else {
                Err(RouteSideError::StringIndexOutOfRange)
            }
        };
        for network in 0..self.network_count {
            let (id_idx, name_idx) = self.network(network);
            string(id_idx)?;
            string(name_idx)?;
        }
        for route in 0..self.route_count {
            let row = self.route(route);
            string(row.desc_idx)?;
            string(row.url_idx)?;
            if row
                .network_ord
                .is_some_and(|ord| ord as usize >= self.network_count)
            {
                return Err(RouteSideError::NetworkOrdinalOutOfRange);
            }
        }
        Ok(())
    }

    pub fn network_count(&self) -> usize {
        self.network_count
    }

    pub fn route_count(&self) -> usize {
        self.route_count
    }

    /// `(id_idx, name_idx)` for a network ordinal. Panics when out of range.
    pub fn network(&self, ordinal: usize) -> (u32, u32) {
        assert!(ordinal < self.network_count, "network ordinal out of range");
        let ids = HEADER_BYTES;
        let names = ids + self.network_count * 4;
        (
            u32_at(self.body, ids + ordinal * 4),
            u32_at(self.body, names + ordinal * 4),
        )
    }

    /// Optional fields for a route ordinal. Panics when out of range.
    pub fn route(&self, ordinal: usize) -> RouteSideRow {
        assert!(ordinal < self.route_count, "route ordinal out of range");
        let base = HEADER_BYTES + self.network_count * NETWORK_COLUMNS * 4;
        let column =
            |index: usize| u32_at(self.body, base + (index * self.route_count + ordinal) * 4);
        let optional = |value: u32| (value != ROUTE_SIDE_ABSENT).then_some(value);
        RouteSideRow {
            desc_idx: column(0),
            url_idx: column(1),
            sort_order: optional(column(2)),
            network_ord: optional(column(3)),
        }
    }
}

/// Encode a version 1 region body from `(id_idx, name_idx)` networks and rows.
pub fn encode_route_side_table(networks: &[(u32, u32)], routes: &[RouteSideRow]) -> Vec<u8> {
    let capacity =
        HEADER_BYTES + networks.len() * NETWORK_COLUMNS * 4 + routes.len() * ROUTE_COLUMNS * 4;
    let mut out = Vec::with_capacity(capacity);
    out.extend_from_slice(&ROUTE_SIDE_TABLE_VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(routes.len() as u32).to_le_bytes());
    out.extend_from_slice(&(networks.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    let mut column = |values: &mut dyn Iterator<Item = u32>| {
        for value in values {
            out.extend_from_slice(&value.to_le_bytes());
        }
    };
    column(&mut networks.iter().map(|n| n.0));
    column(&mut networks.iter().map(|n| n.1));
    column(&mut routes.iter().map(|r| r.desc_idx));
    column(&mut routes.iter().map(|r| r.url_idx));
    column(
        &mut routes
            .iter()
            .map(|r| r.sort_order.unwrap_or(ROUTE_SIDE_ABSENT)),
    );
    column(
        &mut routes
            .iter()
            .map(|r| r.network_ord.unwrap_or(ROUTE_SIDE_ABSENT)),
    );
    out
}
