//! `.producer-data-root-id` — producer↔server data-root sentinel.
//!
//! The producer and pt-serve must read/write the SAME `data_root`. In k8s a single typo can mount
//! them to two different PVCs: the producer faithfully writes new generations to volume A, pt-serve
//! happily mmaps the (stale) bundle from volume B, and the two never converge. The failure is
//! silent — nothing crashes, nothing logs, the served data just stops moving.
//!
//! ## Mechanism
//!
//! At producer startup we write `<data_root>/.producer-data-root-id`
//! containing the producer's view of the data root: `device:inode` from
//! `stat(2)`. At pt-serve startup, we re-stat the data root, read the
//! sentinel file, and compare. Mismatch → exit non-zero with a clear
//! "different mounts" error.
//!
//! The sentinel is OPERABILITY ONLY — it does not gate the publish protocol
//! itself. A failed sentinel write is logged but does not abort a publish
//! (the publish still produces a valid generation under whatever volume
//! the producer reached). pt-serve's verifier is the load-bearing side:
//! it fails closed at startup when the file says one mount and stat
//! reports another.
//!
//! ## On-disk format
//!
//! Plain text, two lines:
//! ```text
//! schemaVersion=1
//! deviceInode=<dev>:<ino>
//! ```
//! Schema-versioned so a future change (e.g. adding hostname) is parseable
//! by older readers via line-prefix matching. The current verifier compares
//! `deviceInode` only.
//!
//! ## Cross-platform note
//!
//! `MetadataExt::dev()` + `MetadataExt::ino()` are `cfg(unix)`. The producer and
//! pt-serve both already target Unix-only (macOS dev, Linux prod); on
//! non-Unix builds the sentinel is a no-op. Windows is not a target.

use crate::error::{Error, Result};
use std::os::fd::AsFd;
use std::path::Path;

/// On-disk schema version. Bump when a NEW required field is added; never
/// bump for an optional addition (parsers tolerate unknown lines).
pub const SENTINEL_SCHEMA_VERSION: u32 = 1;

/// Filename of the sentinel inside the data root.
pub const SENTINEL_FILENAME: &str = ".producer-data-root-id";

/// Write the producer-side sentinel. Called at the start of every
/// `publish_one_tick` (and republish) so the file is refreshed on every
/// publish — if the producer is restarted onto a different mount, the
/// file's stat reflects the NEW mount even if the path was unchanged.
///
/// Failure modes:
/// - `data_root` doesn't exist: propagate the IO error (caller logs).
/// - `stat(2)` fails: propagate.
/// - Sentinel write fails: propagate.
///
/// On Unix-non-target platforms (currently none — both producer and pt-serve
/// are Unix-only) this is a no-op success.
pub fn write_producer_sentinel(data_root: &Path) -> Result<()> {
    let (dev, ino) = stat_device_inode(data_root)?;
    let contents = format!(
        "schemaVersion={}\ndeviceInode={}:{}\n",
        SENTINEL_SCHEMA_VERSION, dev, ino,
    );
    let path = data_root.join(SENTINEL_FILENAME);
    let tmp_path = data_root.join(format!("{SENTINEL_FILENAME}.tmp"));
    // tmp-write → fsync(file) → rename → fsync(parent_dir). Same durability
    // idiom as current.json writes. Earlier revisions used `std::fs::write`
    // direct — that could leave a torn sentinel after a power loss between
    // producer publish and the next pt-serve restart. A torn sentinel makes
    // pt-serve's verifier either fail closed (Malformed) or pass with
    // wrong device:inode bytes. Cost: one extra fsync pair per publish tick
    // (sentinel is small; the overhead is negligible vs the bundle fsyncs
    // already on this code path).
    {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(Error::Io)?;
        f.write_all(contents.as_bytes()).map_err(Error::Io)?;
        pt_shared::fsync::durable(f.as_fd()).map_err(Error::Io)?;
    }
    std::fs::rename(&tmp_path, &path).map_err(Error::Io)?;
    // Parent-dir fsync makes the rename durable across power loss on Linux
    // data=ordered. durable_dir degrades to plain fsync on macOS, where
    // F_FULLFSYNC on a directory fd is unreliable (EBADF/ENOTSUP).
    let d = std::fs::File::open(data_root).map_err(Error::Io)?;
    pt_shared::fsync::durable_dir(d.as_fd()).map_err(Error::Io)?;
    Ok(())
}

/// Read the sentinel file from `data_root` and parse out the
/// `deviceInode` line. Returns `Ok(None)` if the file is absent
/// (pre-Stage-B producer or a first-publish window where the producer
/// has not yet run); returns `Err` on parse failure.
pub fn read_sentinel(data_root: &Path) -> Result<Option<(u64, u64)>> {
    let path = data_root.join(SENTINEL_FILENAME);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::Io(e)),
    };
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| Error::Config(format!("sentinel {} is not utf-8", path.display())))?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("deviceInode=") {
            let mut parts = rest.splitn(2, ':');
            let dev = parts
                .next()
                .ok_or_else(|| Error::Config(format!("sentinel deviceInode missing dev: {rest}")))?
                .parse::<u64>()
                .map_err(|e| Error::Config(format!("sentinel dev parse: {e}")))?;
            let ino = parts
                .next()
                .ok_or_else(|| Error::Config(format!("sentinel deviceInode missing ino: {rest}")))?
                .parse::<u64>()
                .map_err(|e| Error::Config(format!("sentinel ino parse: {e}")))?;
            return Ok(Some((dev, ino)));
        }
    }
    Err(Error::Config(format!(
        "sentinel {} missing deviceInode line",
        path.display()
    )))
}

/// Stat a path and return its (device, inode) tuple. Unix-only.
#[cfg(unix)]
pub fn stat_device_inode(path: &Path) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).map_err(Error::Io)?;
    Ok((m.dev(), m.ino()))
}

#[cfg(not(unix))]
pub fn stat_device_inode(_path: &Path) -> Result<(u64, u64)> {
    Err(Error::Config(
        "stat_device_inode unsupported on non-Unix platforms".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Happy round trip: write a sentinel, read it back, dev:ino matches
    /// the directory's stat.
    #[test]
    fn sentinel_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        write_producer_sentinel(dir.path()).expect("write");
        let (dev, ino) = read_sentinel(dir.path()).expect("read").expect("Some(...)");
        let (expected_dev, expected_ino) = stat_device_inode(dir.path()).expect("stat");
        assert_eq!(dev, expected_dev);
        assert_eq!(ino, expected_ino);
    }

    /// Absent sentinel returns Ok(None) — pre-Stage-B compat path.
    #[test]
    fn missing_sentinel_returns_none() {
        let dir = tempfile::TempDir::new().unwrap();
        let got = read_sentinel(dir.path()).expect("read missing");
        assert!(got.is_none(), "missing sentinel must read as None");
    }

    /// Garbage sentinel surfaces as a parse error (not silent).
    #[test]
    fn malformed_sentinel_is_error() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join(SENTINEL_FILENAME),
            "this is not a sentinel\n",
        )
        .unwrap();
        let err = read_sentinel(dir.path()).expect_err("malformed sentinel must err");
        let msg = err.to_string();
        assert!(
            msg.contains("missing deviceInode"),
            "unexpected error: {msg}"
        );
    }

    /// Schema version line is present and parseable (even though the verifier
    /// doesn't currently key off it).
    #[test]
    fn sentinel_contains_schema_version_line() {
        let dir = tempfile::TempDir::new().unwrap();
        write_producer_sentinel(dir.path()).expect("write");
        let text = std::fs::read_to_string(dir.path().join(SENTINEL_FILENAME)).unwrap();
        assert!(
            text.contains("schemaVersion=1"),
            "missing schemaVersion line: {text}"
        );
    }
}

// ---------------------------------------------------------------------------
// pt-serve version gate
// ---------------------------------------------------------------------------

pub const PT_SERVE_VERSION_FILENAME: &str = "pt-serve.version";

/// Outcome of reading the sentinel.
#[derive(Debug, PartialEq, Eq)]
pub enum PtServeVersionCheck {
    /// File absent — bootstrap path (no pt-serve has run yet, or data root is
    /// brand-new). Producer permits publish with a structured WARN.
    Absent,
    /// File present but unparseable — fail closed; operator must investigate.
    Malformed,
    /// File present, parsed; carries the reported version.
    Present(u16),
}

pub fn read_pt_serve_version(data_root: &std::path::Path) -> PtServeVersionCheck {
    let path = data_root.join(PT_SERVE_VERSION_FILENAME);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return PtServeVersionCheck::Absent,
        Err(_) => return PtServeVersionCheck::Malformed,
    };
    match raw.trim().parse::<u16>() {
        Ok(v) => PtServeVersionCheck::Present(v),
        Err(_) => PtServeVersionCheck::Malformed,
    }
}

#[cfg(test)]
mod pt_serve_version_tests {
    use super::*;

    #[test]
    fn absent_when_file_missing() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(read_pt_serve_version(t.path()), PtServeVersionCheck::Absent);
    }

    #[test]
    fn present_parses_int() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join(PT_SERVE_VERSION_FILENAME), "5\n").unwrap();
        assert_eq!(
            read_pt_serve_version(t.path()),
            PtServeVersionCheck::Present(5)
        );
    }

    #[test]
    fn malformed_on_garbage() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join(PT_SERVE_VERSION_FILENAME), "five\n").unwrap();
        assert_eq!(
            read_pt_serve_version(t.path()),
            PtServeVersionCheck::Malformed
        );
    }
}
