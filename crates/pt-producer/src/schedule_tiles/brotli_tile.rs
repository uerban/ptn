//! Brotli (q=11 by default) for tile payloads — port of `compressTileBytes`
//! (packages/backend/src/gtfs/scheduleTileBrotli.ts:32-65), metrics registry
//! excluded (the producer runs offline with no live registry wired — same as
//! the Node script itself when run standalone).
//!
//! Node calls `brotliCompressSync` with ONLY `BROTLI_PARAM_QUALITY: 11` and
//! `BROTLI_PARAM_MODE: BROTLI_MODE_TEXT` set (scheduleTileBrotli.ts:37-42);
//! it never touches `BROTLI_PARAM_LGWIN` or `BROTLI_PARAM_SIZE_HINT`, so both
//! fall back to zlib's brotli defaults (`BROTLI_DEFAULT_WINDOW` = 22,
//! size hint = 0 for "unknown size" — see
//! <https://nodejs.org/api/zlib.html#brotli-constants>). This wrapper mirrors
//! that by default: quality and mode TEXT are the only fields overridden from
//! `BrotliEncoderParams::default()`, whose `quality`/`lgwin`/`size_hint`
//! already default to 11/22/0 in the `brotli` crate itself
//! (brotli-7.0.0/src/enc/encode.rs `BrotliEncoderInitParams`).
//!
//! Compressed bytes are NOT expected to be byte-identical to Node's libbrotli output (different
//! encoder implementations); only the decompressed payload is contractual. The `TileCompressor`
//! trait lets subdivision/bundle tests inject a deterministic mock, since quadtree cap decisions
//! are driven by compressed sizes that legitimately differ between the two engines.

/// Build-time per-tile compressed-byte ceiling (2 MiB) — mirror of
/// `MAX_COMPRESSED_TILE_BYTES` in scheduleTileBrotli.ts:15 (incl. its TEMP
/// raise from 1.5 MiB for Paris IDFM headroom). Keep the two constants in
/// lockstep.
pub const MAX_COMPRESSED_TILE_BYTES: usize = 2_097_152;

/// Abstraction over "compress these tile bytes" so quadtree subdivision
/// logic (which branches on compressed size vs. the cap) can be tested
/// against a deterministic mock instead of real, engine-dependent brotli
/// output sizes.
pub trait TileCompressor {
    fn compress(&self, input: &[u8]) -> Vec<u8>;
}

/// The quality every published bundle has used so far, and the default.
pub const DEFAULT_TILE_BROTLI_QUALITY: u32 = 11;

/// Real brotli, TEXT mode — the production compressor. `quality` is
/// [`DEFAULT_TILE_BROTLI_QUALITY`] unless the operator lowers it to make
/// the build cheaper: q=11 is nearly all of a dense city's tile-build time
/// (Paris: ~20 min single-threaded on a Ryzen 5 PRO 2400GE). Measured on
/// Paris, q=10 halves the build for ~8% larger tiles; recompressing the same
/// tiles at q=9 is ~20x faster than q=11 for ~34% larger ones. Only the
/// decompressed payload is contractual, so any quality produces a valid
/// bundle; a lower one can split a few more cells, since the subdivision cap
/// is checked against the compressed size.
pub struct Brotli {
    pub quality: u32,
}

impl TileCompressor for Brotli {
    fn compress(&self, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut params = brotli::enc::BrotliEncoderParams {
            mode: brotli::enc::backward_references::BrotliEncoderMode::BROTLI_MODE_TEXT,
            ..Default::default()
        };
        params.quality = self.quality as i32;
        brotli::BrotliCompress(&mut &input[..], &mut out, &params)
            .expect("in-memory brotli compress should not fail");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let input = br#"{"v":1,"hello":"world"}"#.repeat(100);
        let c = Brotli {
            quality: DEFAULT_TILE_BROTLI_QUALITY,
        }
        .compress(&input);
        assert!(c.len() < input.len());
        let mut out = Vec::new();
        brotli::BrotliDecompress(&mut &c[..], &mut out).unwrap();
        assert_eq!(out, input);
    }

    #[test]
    fn node_compressed_tile_decompresses() {
        // Cross-engine sanity: bytes produced by node:zlib brotliCompressSync
        // must decompress here (the gate depends on it).
        // Generate once: node -e 'const z=require("zlib");process.stdout.write(z.brotliCompressSync(Buffer.from("ptn-tile-parity")))' > tests/fixtures/node_brotli.br
        let c = include_bytes!("../../tests/fixtures/node_brotli.br");
        let mut out = Vec::new();
        brotli::BrotliDecompress(&mut &c[..], &mut out).unwrap();
        assert_eq!(out, b"ptn-tile-parity");
    }
}
