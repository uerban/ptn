use crate::error::{PtbError, Result};
use crate::records::rd_u32;

/// Borrowed view over the StringPool region. `region_len` is the region's
/// declared byte length (from the header table) — used for the exact-length check.
pub struct StringPool<'a> {
    bytes: &'a [u8], // the region slice (starts at the pool's `count` field)
    count: u32,
    offsets_base: usize, // byte offset (within `bytes`) of offsets[0]
    blob_base: usize,    // byte offset of the UTF-8 blob
}

impl<'a> StringPool<'a> {
    pub fn parse(region: &'a [u8], region_len: usize) -> Result<Self> {
        let count = rd_u32(region, 0)?;
        // 4 (count) + (count+1)*4 (offsets) must fit.
        let offsets_bytes = (count as usize)
            .checked_add(1)
            .and_then(|n| n.checked_mul(4))
            .ok_or(PtbError::StringPoolMalformed {
                detail: "count overflow",
            })?;
        if 4 + offsets_bytes > region_len {
            return Err(PtbError::StringPoolMalformed {
                detail: "count overflows region length",
            });
        }
        let offsets_base = 4;
        let blob_base = 4 + offsets_bytes;
        let blob_len = rd_u32(region, offsets_base + count as usize * 4)? as usize;
        let expected = 4 + offsets_bytes + blob_len;
        if region_len != expected {
            return Err(PtbError::StringPoolMalformed {
                detail: "length mismatch",
            });
        }
        Ok(StringPool {
            bytes: region,
            count,
            offsets_base,
            blob_base,
        })
    }

    pub fn count(&self) -> u32 {
        self.count
    }

    pub fn str_at(&self, idx: u32) -> Result<&'a str> {
        if idx >= self.count {
            return Err(PtbError::StringIndexOutOfRange {
                idx,
                count: self.count as usize,
            });
        }
        let lo = rd_u32(self.bytes, self.offsets_base + idx as usize * 4)? as usize;
        let hi = rd_u32(self.bytes, self.offsets_base + (idx as usize + 1) * 4)? as usize;
        let slice = self
            .bytes
            .get(self.blob_base + lo..self.blob_base + hi)
            .ok_or(PtbError::SliceOutOfBounds {
                what: "string blob",
            })?;
        core::str::from_utf8(slice).map_err(|_| PtbError::Utf8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn pool_bytes(strings: &[&str]) -> Vec<u8> {
        let count = strings.len() as u32;
        let mut out = Vec::new();
        out.extend_from_slice(&count.to_le_bytes());
        let mut cur = 0u32;
        for s in strings {
            out.extend_from_slice(&cur.to_le_bytes());
            cur += s.len() as u32;
        }
        out.extend_from_slice(&cur.to_le_bytes()); // terminator = blob len
        for s in strings {
            out.extend_from_slice(s.as_bytes());
        }
        out
    }

    #[test]
    fn reads_strings_and_bounds() {
        let bytes = pool_bytes(&["", "S1", "Žalgiris"]); // index 0 = ""
        let p = StringPool::parse(&bytes, bytes.len()).unwrap();
        assert_eq!(p.str_at(0).unwrap(), "");
        assert_eq!(p.str_at(1).unwrap(), "S1");
        assert_eq!(p.str_at(2).unwrap(), "Žalgiris");
        assert!(p.str_at(3).is_err()); // out of range
    }
}
