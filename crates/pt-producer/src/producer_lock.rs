//! `producer.lock` — exclusive flock on `<data_root>/producer.lock`.
//!
//! The producer holds a kernel-mediated advisory flock for the full duration of a publish tick so a
//! second `pt-producer` against the same `--data-root` fails fast rather than racing through the
//! `current.json` rename. Mirrors `pt-serve`'s `PidfileGuard` — the two are deliberately separate
//! types because the on-disk sentinel filenames differ (`pt-serve.pid` vs `producer.lock`) and the
//! error taxonomies feed different runbooks; sharing would force one to drag the other's error
//! class into its dependency closure.
//!
//! ## Lifecycle
//!
//! - `acquire(data_root)` opens `producer.lock` create+read+write, takes
//!   `flock(NonBlockingLockExclusive)`, then truncate-and-writes our PID +
//!   newline under the lock and `fsync`s the writable view.
//! - Drop closes the fd → kernel releases the lock. We also remove the file
//!   as a cosmetic courtesy. The kernel-side release is the load-bearing
//!   property — the file unlink is best-effort.
//! - On `SIGKILL` / OOM / panic, the kernel still releases the lock when the
//!   open-file description is reaped; the lingering file gets overwritten
//!   during the successor's truncate-and-write.
//!
//! ## Two-acquire pattern (matches `PidfileGuard`)
//!
//! We open one fd to hold the lock (`OwnedFd`), then re-open the same path
//! via a regular `File` to call `set_len(0)` + `write_all(pid)`. The two-fd
//! pattern avoids needing `unsafe { File::from_raw_fd(dup(fd)) }` while
//! keeping the original fd's OwnedFd guarding the lock. Concurrent acquirers
//! can't truncate-race us because their own flock attempt hits EWOULDBLOCK
//! before they touch the file.

use rustix::fs::{flock, FlockOperation};
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// RAII handle owning the locked `producer.lock`. Kept on the publish
/// function's stack for the duration of the tick; dropped at the end of the
/// tick (or on early-return error) to release the lock.
#[derive(Debug)]
pub struct ProducerLock {
    // OwnedFd keeps the kernel flock alive. Drop closes → kernel releases.
    fd: Option<OwnedFd>,
    path: PathBuf,
}

#[derive(Debug, Error)]
pub enum ProducerLockError {
    /// Another `pt-producer` against the same `--data-root` already holds
    /// `producer.lock`. `existing_pid` is best-effort: we read the file
    /// contents the OTHER holder wrote; `None` means the file was empty or
    /// the PID line was unparseable (typical for a handover mid-truncate
    /// window).
    #[error("producer.lock already held by pid={}", existing_pid.map(|p| p.to_string()).unwrap_or_else(|| "unknown".into()))]
    AlreadyLocked { existing_pid: Option<u32> },

    /// `data_root` itself doesn't exist or isn't accessible. The caller's
    /// `--data-root` argument validation should have caught this; the
    /// variant exists so `acquire` is total.
    #[error("producer.lock io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Acquire the exclusive lock on `<data_root>/producer.lock`. Returns a guard
/// whose lifetime owns the lock; drop the guard to release.
pub fn acquire(data_root: &Path) -> Result<ProducerLock, ProducerLockError> {
    let path = data_root.join("producer.lock");

    // Open create+read+write — create-if-absent, but DO NOT truncate yet.
    // Truncate happens AFTER the lock is held so a reader of a held file
    // sees either an empty file (race window between create and lock) or a
    // fully-written PID line — never a partial line.
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)?;
    let fd: OwnedFd = file.into();

    if let Err(errno) = flock(&fd, FlockOperation::NonBlockingLockExclusive) {
        let existing_pid = read_existing_pid(&path);
        let _ = errno;
        drop(fd);
        return Err(ProducerLockError::AlreadyLocked { existing_pid });
    }

    // We hold the lock; truncate-and-write the PID line, then fsync.
    {
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)?;
        writeln!(writer, "{}", std::process::id())?;
        // Durable fsync — Linux fsync, macOS F_FULLFSYNC. Same helper
        // pt-serve uses for current.json so the producer + server agree on
        // durability semantics.
        pt_shared::fsync::durable(writer.as_fd())?;
    }

    Ok(ProducerLock { fd: Some(fd), path })
}

impl Drop for ProducerLock {
    fn drop(&mut self) {
        // Remove before close so a successor opening the path after our
        // remove(2) gets a fresh inode with no stale PID. (Removing after
        // fd-close would open a window where a successor could open the
        // still-present file with our old PID.)
        let _ = std::fs::remove_file(&self.path);
        self.fd.take();
    }
}

/// Read the contents of `path` and parse the first line as a u32 PID. Any
/// failure (missing file, empty file, non-numeric content) collapses to
/// `None` — the caller surfaces that as "unknown" in the error message.
fn read_existing_pid(path: &Path) -> Option<u32> {
    let bytes = std::fs::read(path).ok()?;
    let text = std::str::from_utf8(&bytes).ok()?;
    text.lines().next()?.trim().parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_writes_pid_and_drop_removes_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let guard = acquire(dir.path()).expect("acquire");
        let contents =
            std::fs::read_to_string(dir.path().join("producer.lock")).expect("read producer.lock");
        assert_eq!(contents.trim(), std::process::id().to_string());
        drop(guard);
        assert!(
            !dir.path().join("producer.lock").exists(),
            "producer.lock must be removed on drop"
        );
    }

    #[test]
    fn second_acquire_observes_already_locked() {
        let dir = tempfile::TempDir::new().unwrap();
        let first = acquire(dir.path()).expect("first acquire");
        let err = acquire(dir.path()).expect_err("second must fail");
        match err {
            ProducerLockError::AlreadyLocked { existing_pid } => {
                assert_eq!(existing_pid, Some(std::process::id()));
            }
            other => panic!("expected AlreadyLocked, got {other:?}"),
        }
        drop(first);
        let third = acquire(dir.path()).expect("third acquire after drop");
        drop(third);
    }
}
