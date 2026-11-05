//! Minimal protobuf wire-format primitives — just enough to decode the ~4
//! GTFS-RT `TripUpdate` fields `parser.rs` needs. Not a general-purpose
//! protobuf library: no support for packed repeated fields or any message
//! type outside the GTFS-RT TripUpdate subtree. Deprecated proto2 groups are
//! skipped only for unknown-field/extension compatibility with protobufjs.

// Matches protobufjs/protoc's default recursion cap for nested groups.
const MAX_GROUP_DEPTH: usize = 100;

/// Cursor over a protobuf-encoded byte slice.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.pos >= self.buf.len()
    }

    /// Reads a base-128 varint (up to 10 bytes for a full 64-bit value).
    /// Returns `None` on a truncated buffer or a varint longer than 10 bytes
    /// (malformed input — real encoders never emit more than 10 bytes).
    pub fn read_varint(&mut self) -> Option<u64> {
        let mut result: u64 = 0;
        for i in 0..10u32 {
            if self.pos >= self.buf.len() {
                return None;
            }
            let byte = self.buf[self.pos];
            self.pos += 1;
            if i < 9 {
                result |= ((byte & 0x7f) as u64) << (7 * i);
            } else {
                // 10th byte: only bit 0 can contribute to a 64-bit value.
                result |= ((byte & 0x01) as u64) << 63;
            }
            if byte & 0x80 == 0 {
                return Some(result);
            }
        }
        None
    }

    /// Reads a tag varint and splits it into (field_number, wire_type).
    pub fn read_tag(&mut self) -> Option<(u32, u8)> {
        let v = self.read_varint()?;
        Some(((v >> 3) as u32, (v & 0x7) as u8))
    }

    /// Reads a length-delimited field's length prefix, then returns a slice
    /// of exactly that many bytes (borrowed from the original buffer).
    ///
    /// `len` is attacker-controlled (it comes straight from the wire and can
    /// be up to `u64::MAX`), so `self.pos + len` must use `checked_add` —
    /// plain `+` overflows `usize` on a malformed near-`u64::MAX` length,
    /// panicking in debug builds and silently wrapping in release. Mirrors
    /// the `checked_add` idiom already used for this exact class of check in
    /// `crates/pt-core/src/header.rs`.
    pub fn read_length_delimited(&mut self) -> Option<&'a [u8]> {
        let len = self.read_varint()? as usize;
        let end = self.pos.checked_add(len)?;
        if end > self.buf.len() {
            return None;
        }
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Some(slice)
    }

    /// Skips a field of the given wire type without interpreting it —
    /// used for every field this decoder doesn't care about (unknown
    /// fields, extensions, and known-but-unused fields alike).
    pub fn skip_field(&mut self, wire_type: u8) -> Option<()> {
        self.skip_field_at_depth(wire_type, 0)
    }

    fn skip_field_at_depth(&mut self, wire_type: u8, depth: usize) -> Option<()> {
        if depth > MAX_GROUP_DEPTH {
            return None;
        }
        match wire_type {
            0 => {
                self.read_varint()?;
                Some(())
            }
            1 => {
                if self.pos + 8 > self.buf.len() {
                    return None;
                }
                self.pos += 8;
                Some(())
            }
            2 => self.read_length_delimited().map(|_| ()),
            // Groups are deprecated but remain valid in proto2 extensions.
            // protobufjs skips nested fields until the matching end-group wire
            // type; mirror that behavior so vendor extensions stay ignorable.
            3 => loop {
                let (_, nested_wire_type) = self.read_tag()?;
                if nested_wire_type == 4 {
                    return Some(());
                }
                self.skip_field_at_depth(nested_wire_type, depth + 1)?;
            },
            5 => {
                if self.pos + 4 > self.buf.len() {
                    return None;
                }
                self.pos += 4;
                Some(())
            }
            // End-group is valid only while skipping a start-group.
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_varint_single_byte() {
        let mut r = Reader::new(&[0x3c]);
        assert_eq!(r.read_varint(), Some(60));
        assert!(r.is_empty());
    }

    #[test]
    fn read_varint_two_byte_boundary() {
        // 128 is the smallest value needing a continuation byte.
        let mut r = Reader::new(&[0x80, 0x01]);
        assert_eq!(r.read_varint(), Some(128));
    }

    #[test]
    fn read_varint_truncated_returns_none() {
        let mut r = Reader::new(&[0x80]); // continuation bit set, no next byte
        assert_eq!(r.read_varint(), None);
    }

    #[test]
    fn read_varint_all_ten_bytes_continuation_set_returns_none() {
        let mut r = Reader::new(&[0xff; 10]);
        assert_eq!(r.read_varint(), None);
    }

    #[test]
    fn read_varint_decodes_negative_int32_ten_byte_encoding() {
        // Real gtfs-realtime-bindings encoding of `delay: -30` (int32 field,
        // proto2 sign-extends negatives to the full 64-bit two's-complement
        // varint — verified by hand against a live-encoded fixture).
        let mut r = Reader::new(&[0xe2, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
        let v = r.read_varint().unwrap();
        assert_eq!((v as i64) as i32, -30);
    }

    #[test]
    fn read_tag_splits_field_and_wire_type() {
        let mut r = Reader::new(&[0x08]); // field 1, wire type 0
        assert_eq!(r.read_tag(), Some((1, 0)));
        let mut r2 = Reader::new(&[0x12]); // field 2, wire type 2
        assert_eq!(r2.read_tag(), Some((2, 2)));
    }

    #[test]
    fn read_length_delimited_returns_exact_slice() {
        // NOTE: plan's Step 1 code used a trailing 0xff here, but 0xff has
        // its continuation bit (0x80) set, so a lone trailing 0xff is a
        // truncated (not single-byte) varint and correctly decodes to
        // `None`, not `Some(0xff)` — that was a bug in the plan's fixture
        // data, not in `Reader`. Using 0x7f (no continuation bit) preserves
        // the test's intent (trailing byte is left untouched by
        // `read_length_delimited`) while actually being decodable.
        let mut r = Reader::new(&[0x02, 0x65, 0x30, 0x7f]); // len=2, "e0", trailing byte untouched
        assert_eq!(r.read_length_delimited(), Some(&b"e0"[..]));
        assert_eq!(r.read_varint(), Some(0x7f));
    }

    #[test]
    fn read_length_delimited_truncated_returns_none() {
        let mut r = Reader::new(&[0x05, 0x01, 0x02]); // claims len=5, only 2 bytes follow
        assert_eq!(r.read_length_delimited(), None);
    }

    #[test]
    fn read_length_delimited_huge_len_does_not_panic() {
        let mut r = Reader::new(&[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
        assert_eq!(r.read_length_delimited(), None);
    }

    #[test]
    fn read_tag_then_read_length_delimited_in_sequence() {
        let mut r = Reader::new(&[0x12, 0x02, b'e', b'0']); // field 2, wire type 2, len 2, "e0"
        assert_eq!(r.read_tag(), Some((2, 2)));
        assert_eq!(r.read_length_delimited(), Some(&b"e0"[..]));
        assert!(r.is_empty());
    }

    #[test]
    fn skip_field_handles_all_supported_wire_types() {
        // wire type 0 (varint)
        let mut r = Reader::new(&[0x96, 0x01]);
        assert_eq!(r.skip_field(0), Some(()));
        assert!(r.is_empty());

        // wire type 1 (64-bit fixed)
        let mut r = Reader::new(&[0u8; 8]);
        assert_eq!(r.skip_field(1), Some(()));
        assert!(r.is_empty());

        // wire type 2 (length-delimited)
        let mut r = Reader::new(&[0x03, 0xaa, 0xbb, 0xcc]);
        assert_eq!(r.skip_field(2), Some(()));
        assert!(r.is_empty());

        // wire type 5 (32-bit fixed)
        let mut r = Reader::new(&[0u8; 4]);
        assert_eq!(r.skip_field(5), Some(()));
        assert!(r.is_empty());
    }

    #[test]
    fn skip_field_skips_group_and_leaves_trailing_bytes() {
        // Outer field 1 group contains field 2 varint=150, then end-group.
        let mut r = Reader::new(&[0x10, 0x96, 0x01, 0x0c, 0x7f]);
        assert_eq!(r.skip_field(3), Some(()));
        assert_eq!(r.read_varint(), Some(0x7f));
    }

    #[test]
    fn skip_field_skips_nested_groups() {
        // Outer group -> nested field 2 group -> field 3 bytes -> both ends.
        let mut r = Reader::new(&[0x13, 0x1a, 0x01, 0xaa, 0x14, 0x0c]);
        assert_eq!(r.skip_field(3), Some(()));
        assert!(r.is_empty());
    }

    #[test]
    fn skip_field_rejects_unterminated_or_standalone_end_group() {
        let mut unterminated = Reader::new(&[0x10, 0x01]);
        assert_eq!(unterminated.skip_field(3), None);
        let mut standalone_end = Reader::new(&[]);
        assert_eq!(standalone_end.skip_field(4), None);
    }

    #[test]
    fn skip_field_caps_group_recursion() {
        let nested_start_groups = vec![0x0b; MAX_GROUP_DEPTH + 2];
        let mut r = Reader::new(&nested_start_groups);
        assert_eq!(r.skip_field(3), None);
    }
}
