//! Cross-platform durable-fsync helper.
//!
//! `fsync(2)` on macOS only flushes filesystem metadata to disk — the page
//! cache may stay in the drive's volatile buffer until a power loss flushes it
//! to the wrong place. `F_FULLFSYNC` is the documented APFS/HFS+ remedy:
//! it flushes the on-disk cache too. Both the producer publish protocol and
//! pt-serve's last-good promotion step go through this helper so dev (macOS)
//! and prod (Linux) get the strongest durability each platform offers.
//!
//! The helper takes [`BorrowedFd`] (not a path) so callers commit the SAME fd
//! whose dirty pages they wrote. On macOS, `F_FULLFSYNC` on a fd opened
//! read-only is a no-op for any still-open write fd's pending pages — pass the
//! write fd that produced the bytes.

use std::io;
use std::os::fd::BorrowedFd;

/// Durably flush a file's contents to physical media.
///
/// - **Linux:** `fsync(2)` — sufficient on tmpfs/ext4/xfs/btrfs.
/// - **macOS:** `fcntl(F_FULLFSYNC)` via `rustix::fs::fcntl_fullfsync`.
///
/// Returns an `io::Error` mapped from `rustix::io::Errno`; the standard
/// `From<Errno> for io::Error` conversion preserves the platform errno so
/// callers can match on `e.raw_os_error()` if needed.
pub fn durable(fd: BorrowedFd<'_>) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        rustix::fs::fsync(fd).map_err(io::Error::from)
    }
    #[cfg(target_os = "macos")]
    {
        rustix::fs::fcntl_fullfsync(fd).map_err(io::Error::from)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        compile_error!(
            "pt-serve targets Linux production / macOS dev; \
             durable fsync is not defined for this OS"
        )
    }
}

/// Durably flush a DIRECTORY fd (the parent-dir half of the durable-rename
/// idiom).
///
/// - **Linux (prod):** `fsync(2)` on the dir fd — the canonical pairing for a
///   durable rename. Errors propagate: a failed parent fsync means the rename
///   may not survive power loss.
/// - **macOS (dev/CI):** `F_FULLFSYNC` is not reliably supported on directory
///   fds (`EBADF`/`ENOTSUP` depending on filesystem), so [`durable`] would
///   turn every publish/promote into a spurious failure. Try `F_FULLFSYNC`
///   first, fall back to plain `fsync(2)`, and propagate only the fallback's
///   error. APFS/HFS+ dir-entry durability is already largely covered by the
///   file-level `F_FULLFSYNC` the caller issued before the rename.
pub fn durable_dir(fd: BorrowedFd<'_>) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        rustix::fs::fsync(fd).map_err(io::Error::from)
    }
    #[cfg(target_os = "macos")]
    {
        match rustix::fs::fcntl_fullfsync(fd) {
            Ok(()) => Ok(()),
            Err(_) => rustix::fs::fsync(fd).map_err(io::Error::from),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        compile_error!(
            "pt-serve targets Linux production / macOS dev; \
             durable fsync is not defined for this OS"
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::fd::AsFd;

    /// Smoke: `durable_dir` on a directory fd must return Ok on both dev
    /// (macOS, where F_FULLFSYNC on a dir fd may fail and the helper falls
    /// back to plain fsync) and prod (Linux) — a spurious dir-fsync error
    /// here would fail every producer publish / pt-serve last-good promote.
    #[test]
    fn durable_dir_returns_ok_on_directory_fd() {
        let dir = tempfile::tempdir().unwrap();
        let d = std::fs::File::open(dir.path()).unwrap();
        durable_dir(d.as_fd()).expect("durable_dir on a directory fd must succeed");
    }

    /// Smoke: open a tempfile, write a byte, durably commit, drop. The host
    /// kernel is left to decide what "durable" means; we only assert the
    /// helper returns Ok on a normal fd.
    #[test]
    fn durable_returns_ok_on_open_write_fd() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fsync.smoke");
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        f.write_all(b"x").unwrap();
        durable(f.as_fd()).expect("durable fsync on a writable fd must succeed");
    }
}
