//! Producer↔server data-root mount sentinel (verifier side).
//!
//! Mirror of `crates/pt-producer/src/sentinel.rs` — that file WRITES the sentinel at producer
//! startup; this file READS and VERIFIES it at pt-serve startup. The check fails closed: a mismatch
//! between the recorded device:inode and the stat we observe means producer and server have
//! different mounts (k8s PVC misconfig), and we exit non-zero with a clear error rather than
//! serving stale data forever.
//!
//! ## On-disk format
//!
//! Plain text, two lines:
//! ```text
//! schemaVersion=1
//! deviceInode=<dev>:<ino>
//! ```
//! The verifier is forward-compatible: unknown lines are ignored, the
//! verification keys off `deviceInode` only.
//!
//! ## Failure-mode policy
//!
//! - **Sentinel absent** → OK. The producer hasn't run yet (pre-Stage-B
//!   compat: the producer used to omit this file entirely). pt-serve must
//!   still boot from `current.json` so a brand-new deployment doesn't
//!   block on the producer's first publish landing.
//! - **Sentinel malformed** → Fail closed. A corrupt sentinel could mask a
//!   real misconfig; we refuse to start.
//! - **Sentinel mismatches stat** → Fail closed with explicit error.
//!
//! ## Call site
//!
//! `main.rs` invokes [`verify_producer_sentinel`] AFTER pidfile acquire (so
//! "another pt-serve already running" wins the diagnostic) and BEFORE
//! `load_initial_generation` (so a wrong-mount data root produces a clear
//! error rather than a confusing "stale generation" surface).

use std::path::{Path, PathBuf};
use thiserror::Error;

/// Mirror of `crates/pt-producer/src/sentinel.rs::SENTINEL_FILENAME`.
/// Hard-coded because pt-serve does not depend on the producer crate. A drift
/// between the two constants would be caught by the
/// integration test in `tests/sentinel_mount.rs`.
pub const SENTINEL_FILENAME: &str = ".producer-data-root-id";

/// Errors raised by [`verify_producer_sentinel`].
///
/// `main.rs` formats these as fail-closed stderr lines and exits non-zero;
/// no error path expects the caller to recover.
#[derive(Debug, Error)]
pub enum SentinelError {
    /// Could not stat the data root itself. Usually `ENOENT` — the path
    /// doesn't exist or isn't accessible to this process.
    #[error("sentinel: failed to stat data root {path:?}: {source}")]
    StatDataRoot {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// I/O error reading the sentinel file (something other than NotFound,
    /// which is a benign no-op).
    #[error("sentinel: failed to read {path:?}: {source}")]
    ReadFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// Sentinel exists but is unparseable.
    #[error("sentinel: malformed file {path:?}: {detail}")]
    Malformed { path: PathBuf, detail: String },
    /// Sentinel recorded `(producer_dev, producer_ino)` but stat reports
    /// `(server_dev, server_ino)`. The two MUST be equal; mismatch means
    /// producer and server are on different mounts.
    #[error(
        "sentinel mismatch: producer recorded device:inode={producer_dev}:{producer_ino}, \
         but pt-serve sees {server_dev}:{server_ino} — producer and server have \
         different data-root mounts (misconfiguration)"
    )]
    Mismatch {
        producer_dev: u64,
        producer_ino: u64,
        server_dev: u64,
        server_ino: u64,
    },
}

/// Verify the producer sentinel against pt-serve's view of `data_root`.
///
/// Returns `Ok(())` when:
/// - The sentinel file does not exist (pre-Stage-B compat).
/// - The sentinel exists AND `device:inode` matches `data_root`'s stat.
///
/// Returns `Err(...)` when:
/// - `data_root` itself isn't statable.
/// - The sentinel is present but malformed.
/// - The recorded device:inode doesn't match.
pub fn verify_producer_sentinel(data_root: &Path) -> Result<(), SentinelError> {
    let sentinel_path = data_root.join(SENTINEL_FILENAME);
    let bytes = match std::fs::read(&sentinel_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(SentinelError::ReadFile {
                path: sentinel_path,
                source: e,
            })
        }
    };
    let text = std::str::from_utf8(&bytes).map_err(|e| SentinelError::Malformed {
        path: sentinel_path.clone(),
        detail: format!("not utf-8: {e}"),
    })?;
    let (producer_dev, producer_ino) =
        parse_device_inode(text).map_err(|detail| SentinelError::Malformed {
            path: sentinel_path.clone(),
            detail,
        })?;
    let (server_dev, server_ino) = stat_device_inode(data_root)?;
    if producer_dev != server_dev || producer_ino != server_ino {
        return Err(SentinelError::Mismatch {
            producer_dev,
            producer_ino,
            server_dev,
            server_ino,
        });
    }
    Ok(())
}

/// Extract `(dev, ino)` from a sentinel file body. The accepted format is
/// the one written by the producer (`deviceInode=<dev>:<ino>`).
fn parse_device_inode(text: &str) -> Result<(u64, u64), String> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("deviceInode=") {
            let mut parts = rest.splitn(2, ':');
            let dev = parts
                .next()
                .ok_or_else(|| format!("deviceInode missing dev: {rest}"))?
                .parse::<u64>()
                .map_err(|e| format!("dev parse error: {e}"))?;
            let ino = parts
                .next()
                .ok_or_else(|| format!("deviceInode missing ino: {rest}"))?
                .parse::<u64>()
                .map_err(|e| format!("ino parse error: {e}"))?;
            return Ok((dev, ino));
        }
    }
    Err("missing deviceInode line".into())
}

#[cfg(unix)]
fn stat_device_inode(path: &Path) -> Result<(u64, u64), SentinelError> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).map_err(|e| SentinelError::StatDataRoot {
        path: path.to_path_buf(),
        source: e,
    })?;
    Ok((m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn stat_device_inode(_path: &Path) -> Result<(u64, u64), SentinelError> {
    Err(SentinelError::Malformed {
        path: _path.to_path_buf(),
        detail: "non-Unix platforms not supported".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_sentinel(dir: &Path, dev: u64, ino: u64) {
        let body = format!("schemaVersion=1\ndeviceInode={dev}:{ino}\n");
        std::fs::write(dir.join(SENTINEL_FILENAME), body).unwrap();
    }

    /// Missing sentinel is OK — pre-Stage-B producer compatibility.
    #[test]
    fn missing_sentinel_is_ok() {
        let dir = tempfile::TempDir::new().unwrap();
        verify_producer_sentinel(dir.path()).expect("missing sentinel must be OK");
    }

    /// Matching sentinel passes verification.
    #[test]
    fn matching_sentinel_passes() {
        let dir = tempfile::TempDir::new().unwrap();
        let (dev, ino) = stat_device_inode(dir.path()).expect("stat");
        write_sentinel(dir.path(), dev, ino);
        verify_producer_sentinel(dir.path()).expect("matching sentinel must pass");
    }

    /// Mismatched sentinel returns Mismatch.
    #[test]
    fn mismatched_sentinel_returns_mismatch() {
        let dir = tempfile::TempDir::new().unwrap();
        let (dev, ino) = stat_device_inode(dir.path()).expect("stat");
        // Flip the inode by 1 to simulate a different mount.
        write_sentinel(dir.path(), dev, ino.wrapping_add(1));
        let err = verify_producer_sentinel(dir.path()).expect_err("mismatched sentinel must fail");
        match err {
            SentinelError::Mismatch {
                producer_dev,
                producer_ino,
                server_dev,
                server_ino,
            } => {
                assert_eq!(producer_dev, dev);
                assert_eq!(producer_ino, ino.wrapping_add(1));
                assert_eq!(server_dev, dev);
                assert_eq!(server_ino, ino);
            }
            other => panic!("expected Mismatch, got {other:?}"),
        }
    }

    /// Malformed sentinel surfaces as Malformed (not silently passes).
    #[test]
    fn malformed_sentinel_returns_malformed() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(SENTINEL_FILENAME), b"garbage\n").unwrap();
        let err = verify_producer_sentinel(dir.path()).expect_err("malformed sentinel must fail");
        match err {
            SentinelError::Malformed { detail, .. } => {
                assert!(
                    detail.contains("missing deviceInode"),
                    "unexpected detail: {detail}"
                );
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    /// Forward-compat: extra lines after the `deviceInode=` line are
    /// silently ignored. A future producer rev can add new fields without
    /// breaking older pt-serve binaries.
    #[test]
    fn extra_lines_are_ignored() {
        let dir = tempfile::TempDir::new().unwrap();
        let (dev, ino) = stat_device_inode(dir.path()).expect("stat");
        let body = format!("schemaVersion=2\ndeviceInode={dev}:{ino}\nfutureField=somevalue\n");
        std::fs::write(dir.path().join(SENTINEL_FILENAME), body).unwrap();
        verify_producer_sentinel(dir.path()).expect("forward-compat must pass");
    }
}
