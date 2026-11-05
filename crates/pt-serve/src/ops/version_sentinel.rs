//! `pt-serve.version` — deploy-ordering sentinel.
//!
//! pt-serve writes its supported PTB version (`pt_core::PTB_VERSION`) to
//! `<data_root>/pt-serve.version` at STARTUP — before it loads its first generation — so the file
//! advertises the running binary's READ-CAPABILITY the moment the process is up, not only after a
//! successful load. The producer reads this file before publishing to confirm a consumer that can
//! read the bundle it is about to emit is already rolled out.
//!
//! Writing at startup (rather than post-load) removes a bootstrap chicken-and-
//! egg: on a fresh data root / producer-first / stale-pt-serve rollout the
//! sentinel would otherwise be Absent while a capable pt-serve is in fact
//! running, defeating the producer's "absent ⇒ no capable server" fail-closed
//! gate for the current contract.
//!
//! Format: a single ASCII unsigned integer + trailing newline. Forward-
//! compatible: producer-side readers parse it leniently (whitespace
//! tolerated, trailing junk ignored).
//!
//! Overwritten on every startup so the value always tracks the running binary's
//! own `PTB_VERSION` rather than stale process state.

use std::io::Write as _;
use std::path::Path;

/// Filename. Sibling of `.producer-data-root-id` under the data root.
pub const VERSION_SENTINEL_FILENAME: &str = "pt-serve.version";

/// Write `<version>\n` to `<data_root>/pt-serve.version`, atomically
/// (tmp-write + rename) so a partial write can't fool the producer's
/// reader into seeing an unparseable value.
pub fn write_pt_serve_version(data_root: &Path, version: u16) -> std::io::Result<()> {
    let final_path = data_root.join(VERSION_SENTINEL_FILENAME);
    let tmp_path = data_root.join(format!("{VERSION_SENTINEL_FILENAME}.tmp"));
    {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)?;
        writeln!(f, "{version}")?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp_path, &final_path)?;
    // Parent-dir fsync makes the rename durable across power loss on Linux
    // data=ordered — mirrors the producer-side `.producer-data-root-id` sentinel
    // (`crates/pt-producer/src/sentinel.rs`). durable_dir degrades to plain fsync on
    // macOS, where F_FULLFSYNC on a directory fd is unreliable.
    {
        use std::os::fd::AsFd as _;
        let d = std::fs::File::open(data_root)?;
        pt_shared::fsync::durable_dir(d.as_fd())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        write_pt_serve_version(tmp.path(), 5).unwrap();
        let content = std::fs::read_to_string(tmp.path().join(VERSION_SENTINEL_FILENAME)).unwrap();
        assert_eq!(content, "5\n");
        // Overwrite to simulate downgrade
        write_pt_serve_version(tmp.path(), 4).unwrap();
        let content = std::fs::read_to_string(tmp.path().join(VERSION_SENTINEL_FILENAME)).unwrap();
        assert_eq!(content, "4\n");
    }
}
