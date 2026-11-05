//! LEB128 unsigned varints and the zigzag signed mapping.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VarintError {
    Truncated,
    Overflow,
}

pub fn write_uvarint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

pub fn read_uvarint(buf: &[u8], pos: &mut usize) -> Result<u64, VarintError> {
    let mut v: u64 = 0;
    let mut shift = 0u32;
    loop {
        let b = *buf.get(*pos).ok_or(VarintError::Truncated)?;
        *pos += 1;
        if shift == 63 && b > 1 {
            return Err(VarintError::Overflow);
        }
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok(v);
        }
        shift += 7;
        if shift > 63 {
            return Err(VarintError::Overflow);
        }
    }
}

pub fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

pub fn unzigzag(u: u64) -> i64 {
    ((u >> 1) as i64) ^ -((u & 1) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_unsigned_values() {
        for v in [0u64, 1, 127, 128, 300, u64::from(u32::MAX), u64::MAX] {
            let mut out = Vec::new();
            write_uvarint(&mut out, v);
            let mut pos = 0;
            assert_eq!(read_uvarint(&out, &mut pos), Ok(v));
            assert_eq!(pos, out.len());
        }
    }

    #[test]
    fn small_values_take_one_byte() {
        let mut out = Vec::new();
        write_uvarint(&mut out, 127);
        assert_eq!(out, vec![0x7f]);
        out.clear();
        write_uvarint(&mut out, 128);
        assert_eq!(out, vec![0x80, 0x01]);
    }

    #[test]
    fn rejects_truncated_and_overlong_input() {
        let mut pos = 0;
        assert_eq!(read_uvarint(&[0x80], &mut pos), Err(VarintError::Truncated));
        let mut pos = 0;
        assert_eq!(
            read_uvarint(&[0xff; 11], &mut pos),
            Err(VarintError::Overflow)
        );
        let mut pos = 0;
        let mut ten = vec![0xff; 9];
        ten.push(0x02); // 10th byte may only carry bit 63
        assert_eq!(read_uvarint(&ten, &mut pos), Err(VarintError::Overflow));
    }

    #[test]
    fn zigzag_round_trips_signed_values() {
        for v in [
            0i64,
            -1,
            1,
            i64::from(i32::MIN),
            i64::from(i32::MAX),
            -1_800_000_000,
        ] {
            assert_eq!(unzigzag(zigzag(v)), v);
        }
        assert_eq!(zigzag(0), 0);
        assert_eq!(zigzag(-1), 1);
        assert_eq!(zigzag(1), 2);
    }
}
