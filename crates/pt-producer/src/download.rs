use crate::error::{Error, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// One downloaded (or local) GTFS feed. Captures the inputs Phase B's Q1.E
/// sidecar contract needs: the source URL (for the meta sidecar's `feeds[].url`),
/// the on-disk zip path (for Pass-1/Pass-2 extraction), the SHA-256 of the raw
/// zip bytes (for `feeds[].blobSha256`), and the HTTP ETag header if present
/// (for `feeds[].etag` — `None` when the server didn't send one or the feed
/// was loaded from a local path).
#[derive(Clone)]
pub struct FeedRecord {
    pub url: String,
    pub zip_path: PathBuf,
    pub sha_hex: String,
    pub etag: Option<String>,
}

pub fn fetch(url_or_csv: &str, out_dir: &Path) -> Result<Vec<FeedRecord>> {
    let urls: Vec<&str> = url_or_csv
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if urls.is_empty() {
        return Err(Error::Http("empty url list".into()));
    }
    let builder = ureq::AgentBuilder::new();
    #[cfg(all(target_arch = "arm", target_env = "musl"))]
    let builder = builder.tls_connector(std::sync::Arc::new(
        ureq::native_tls::TlsConnector::new()
            .map_err(|error| Error::Http(format!("initialize TLS: {error}")))?,
    ));
    let agent = builder.build();
    let mut out = Vec::with_capacity(urls.len());
    for (i, url) in urls.iter().enumerate() {
        let dest = out_dir.join(format!("feed-{i}.zip"));
        eprintln!("[producer] downloading {url} → {}", dest.display());
        let response = agent
            .get(url)
            .timeout(std::time::Duration::from_secs(300))
            .call()
            .map_err(|e| Error::Http(format!("GET {url}: {e}")))?;
        // Capture ETag BEFORE into_reader() — once we consume the body the
        // header API is gone.
        let etag = response.header("etag").map(str::to_string);

        let mut file = std::fs::File::create(&dest)?;
        let mut reader = response.into_reader();
        let (sha_hex, total) = stream_hash_copy(&mut reader, &mut file)?;
        file.flush()?;
        eprintln!(
            "[producer] gtfs_sha256={sha_hex} bytes={total} path={}",
            dest.display()
        );
        out.push(FeedRecord {
            url: (*url).to_string(),
            zip_path: dest,
            sha_hex,
            etag,
        });
    }
    Ok(out)
}

/// Build a FeedRecord for a local-path zip (e.g. `--gtfs-path tiny-gtfs.zip`).
/// Hashes the file in place; does NOT copy. ETag is `None` (no HTTP exchange).
pub fn record_for_local(path: &Path) -> Result<FeedRecord> {
    let mut file = std::fs::File::open(path)?;
    let (sha_hex, total) = stream_hash(&mut file)?;
    eprintln!(
        "[producer] gtfs_sha256={sha_hex} bytes={total} path={}",
        path.display()
    );
    Ok(FeedRecord {
        url: format!("file://{}", path.display()),
        zip_path: path.to_path_buf(),
        sha_hex,
        etag: None,
    })
}

/// Streams `reader` into `writer` while computing SHA-256 on every byte. One
/// pass, no buffering beyond the 64 KiB chunk. Returns `(hex_sha, byte_count)`.
fn stream_hash_copy<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        writer.write_all(&buf[..n])?;
        total += n as u64;
    }
    Ok((hex_lower(&hasher.finalize()), total))
}

/// Streams `reader` through SHA-256 without writing the bytes anywhere.
fn stream_hash<R: Read>(reader: &mut R) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((hex_lower(&hasher.finalize()), total))
}

/// Compatibility shim: the original Phase A API was
/// `log_gtfs_provenance(path) -> Result<()>` and a test in `tests/sha_capture.rs`
/// calls it directly. Re-implemented on top of `stream_hash` so the stderr
/// format is byte-identical to the original.
pub fn log_gtfs_provenance(path: &Path) -> Result<()> {
    let mut file = std::fs::File::open(path)?;
    let (sha_hex, total) = stream_hash(&mut file)?;
    eprintln!(
        "[producer] gtfs_sha256={sha_hex} bytes={total} path={}",
        path.display()
    );
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xF) as usize] as char);
    }
    s
}
