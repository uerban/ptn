//! `PidfileGuard` — kernel-released exclusive lock on a pidfile.
//!
//! Before binding any listener, `main.rs` acquires this guard against the operator-supplied
//! `--pidfile-path`. The lock has three load-bearing properties:
//!
//! 1. **Kernel-released on death.** `flock(2)` is a kernel-mediated advisory
//!    lock: when the holding process dies — including `SIGKILL`, OOMKill, a
//!    bus error, or a clean exit — the kernel releases the lock automatically
//!    when the underlying open-file description is reaped. A successor
//!    `pt-serve` started immediately afterwards can acquire it. No stale-lock
//!    cleanup is required.
//!
//! 2. **Atomic write under the lock.** Once we hold the lock, we truncate the
//!    pidfile, write our PID + newline, and `fsync` durably. A reader of the
//!    file always sees either an empty file (race window between create and
//!    lock + truncate) or a complete PID line — never a partial line.
//!
//! 3. **RAII drop releases the lock and unlinks the file.** On clean shutdown,
//!    `PidfileGuard::drop` removes the file as a courtesy. After `SIGKILL` or
//!    `std::process::exit` the Drop does NOT run; the file lingers with the
//!    dead PID and a fresh `pt-serve` overwrites it during its own acquire().
//!    The kernel-released lock is the load-bearing exclusion mechanism — the
//!    file unlink is purely cosmetic.
//!
//! ## Sidecar / signaler ergonomics
//!
//! The producer reads the pidfile contents to discover which PID to `SIGHUP` after a publish. The
//! signaler MUST re-read the pidfile on every signal, never cache it, because a previous holder may
//! have died and a successor with a different PID may now hold the lock. The lock-release semantics
//! above guarantee the file contents and the actual server's PID converge after at most one acquire
//! cycle.
//!
//! ## Statfs warning
//!
//! On Linux, we call `statfs(2)` against the pidfile parent and emit a stderr
//! WARN line if the magic matches a known-unsupported filesystem (NFS, CIFS,
//! tmpfs, overlayfs, FUSE). We **warn, never fail** — operators are expected
//! to gate on the warning, but a noisy CI run on an exotic FS must not block
//! startup. On macOS the check is a no-op (pt-serve targets Linux production;
//! macOS is dev-only).

use rustix::fs::{flock, FlockOperation};
use std::io::Write;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// RAII handle that owns the locked pidfile. Held alive on `main.rs`'s stack
/// for the full process lifetime; dropping it releases the lock (via fd close
/// → kernel reap) and removes the file (a courtesy — the kernel does the real
/// work).
///
/// **Drop semantics.** Drop runs on normal `main` return AND on panic unwind
/// in `main`. Drop does NOT run after `std::process::exit(N)` — but `flock`'s
/// kernel-side release fires at process termination regardless, so the lock
/// exclusion property holds either way. Only the file unlink is skipped on
/// `process::exit`; a successor reads the stale PID, overwrites it during
/// its own acquire, and proceeds.
#[derive(Debug)]
pub struct PidfileGuard {
    // Keeping the OwnedFd alive is what holds the kernel-side flock. Drop on
    // OwnedFd closes the fd → kernel releases the open-file-description-scoped
    // lock. The file unlink in PidfileGuard::drop is a cosmetic best-effort.
    fd: Option<OwnedFd>,
    path: PathBuf,
}

/// Failure modes from [`acquire`]. The display strings are the
/// operator-facing tags surfaced on stderr by `main.rs`.
#[derive(Debug, Error)]
pub enum PidfileError {
    /// Another process holds the lock. `existing_pid` is the PID we read out
    /// of the file under the OTHER process's lock; `None` means the file was
    /// empty / unparseable (the holder hasn't written its PID yet, or the
    /// file was truncated mid-handover).
    #[error("pidfile already locked by pid={}", existing_pid.map(|p| p.to_string()).unwrap_or_else(|| "unknown".into()))]
    AlreadyLocked { existing_pid: Option<u32> },

    /// The pidfile path has no parent directory (e.g. a bare filename with
    /// no slashes when cwd-relative semantics are refused upstream). The
    /// `ServerConfig::validate` step rejects this in normal flow; this
    /// variant exists so `acquire` itself is total.
    #[error("pidfile path has no parent directory: {0:?}")]
    InvalidParent(PathBuf),

    /// Any other IO error from the open / truncate / write / fsync sequence.
    #[error("pidfile io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Acquire an exclusive non-blocking flock on `path` and write the current
/// PID to it. Returns a guard whose lifetime owns the lock.
///
/// **Race-free acquire.** We open the file with create+read+write, then
/// flock, then truncate-and-write. The flock is the synchronisation point:
/// a concurrent `pt-serve` racing for the same path either acquires it
/// first (we get EWOULDBLOCK and return `AlreadyLocked`) or loses (we
/// proceed). The truncate-and-write happens strictly AFTER the lock is
/// held, so a reader of a held file sees a fully-written PID line.
///
/// **Statfs warning.** We `statfs` the parent directory and log a stderr
/// WARN if the magic identifies an unsupported filesystem. The
/// warning is paranoia, never a hard fail: an operator on an exotic FS
/// still gets a running server, just with documentation that the
/// publish-protocol guarantees may not hold.
pub fn acquire(path: &Path) -> Result<PidfileGuard, PidfileError> {
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => return Err(PidfileError::InvalidParent(path.to_path_buf())),
    };
    warn_on_unsupported_filesystem(parent);

    // Open create+read+write — create-if-absent, but DO NOT truncate yet.
    // A truncate before we hold the lock would race with the other process's
    // PID-line write window: the other holder could see "we just got rid of
    // your PID line and now we're not the holder" mid-handover. Trunc AFTER
    // flock makes the visible-state transitions atomic from any reader's POV.
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    let fd: OwnedFd = file.into();

    // Non-blocking exclusive lock. EWOULDBLOCK → another process holds it.
    if let Err(errno) = flock(&fd, FlockOperation::NonBlockingLockExclusive) {
        // Read whatever PID the holder wrote (best-effort — file may be empty
        // or unparseable; that's fine, AlreadyLocked carries an Option).
        let existing_pid = read_existing_pid(path);
        // Drop the fd explicitly so we don't leak an opened-but-unlocked
        // descriptor while we surface the error. `_ = errno` keeps the
        // borrow checker quiet about the unused binding.
        let _ = errno;
        drop(fd);
        return Err(PidfileError::AlreadyLocked { existing_pid });
    }

    // We hold the lock. Truncate-and-write the PID line, then fsync. We
    // reopen via a regular `File` view so we can use the std Write impl;
    // the OwnedFd we hold continues to pin the lock.
    {
        // SAFETY: the OwnedFd we hold is the source of truth for the kernel
        // lock; we need a writable view to call `set_len` + `write_all`. The
        // simplest path is to re-open the same path with truncate. A
        // concurrent acquirer cannot truncate-race us because they would hit
        // EWOULDBLOCK on their own flock attempt.
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)?;
        writeln!(writer, "{}", std::process::id())?;
        pt_shared::fsync::durable(writer.as_fd())?;
    }

    Ok(PidfileGuard {
        fd: Some(fd),
        path: path.to_path_buf(),
    })
}

impl Drop for PidfileGuard {
    fn drop(&mut self) {
        // Remove the file BEFORE closing the fd so a successor opening the
        // path after our remove(2) gets a fresh inode with no stale PID.
        // (Removing after fd-close opens a window where a successor could
        // open the still-present file with our old PID.)
        let _ = std::fs::remove_file(&self.path);
        // Now close the fd → kernel releases the flock.
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

// ----------------------------------------------------------------------------
// Statfs warning
// ----------------------------------------------------------------------------

/// Linux-side filesystem magic numbers we consider unsupported for the
/// pidfile parent. The values come straight from `linux/magic.h` (UAPI),
/// so they're stable across kernel versions.
///
/// We DO NOT include `tmpfs` in the hard-fail list — tmpfs is technically
/// usable for a pidfile (flock works) but it does not survive a container
/// restart, which the spec calls out as a footgun for `data-root`. For the
/// pidfile specifically it's a soft footgun (a fresh pid file at each boot
/// is fine), but we still warn so the operator can audit the surface.
#[cfg(target_os = "linux")]
mod magics {
    pub const NFS_SUPER_MAGIC: i64 = 0x6969;
    pub const SMB_SUPER_MAGIC: i64 = 0x517B;
    pub const SMB2_MAGIC_NUMBER: i64 = 0xFE53_4D42; // smb2
    pub const CIFS_MAGIC_NUMBER: i64 = -0x00AB_B294_i64; // 0xFF53_4D42 sign-extended as i64
    pub const FUSE_SUPER_MAGIC: i64 = 0x6573_5546;
    pub const OVERLAYFS_SUPER_MAGIC: i64 = 0x794C_7630;
    pub const TMPFS_MAGIC: i64 = 0x0102_1994;
}

/// Emit a single-line stderr WARN if the parent directory of the pidfile
/// lives on a known-unsupported filesystem. NEVER fails — paranoia only.
///
/// Linux-only. On macOS the check is skipped (dev-only platform; we don't
/// maintain magic↔fstypename mapping).
#[cfg(target_os = "linux")]
fn warn_on_unsupported_filesystem(parent: &Path) {
    let st = match rustix::fs::statfs(parent) {
        Ok(st) => st,
        Err(e) => {
            // statfs itself failed — log and proceed. Operators auditing the
            // surface still get a signal; startup is not gated on this.
            eprintln!(
                "{{\"level\":\"warn\",\"event\":\"pidfile_statfs_failed\",\"path\":{:?},\"errno\":{}}}",
                parent.to_string_lossy(),
                e.raw_os_error()
            );
            return;
        }
    };
    let f_type = st.f_type as i64;
    let (label, supported) = match f_type {
        magics::NFS_SUPER_MAGIC => ("nfs", false),
        magics::SMB_SUPER_MAGIC | magics::SMB2_MAGIC_NUMBER | magics::CIFS_MAGIC_NUMBER => {
            ("cifs/smb", false)
        }
        magics::FUSE_SUPER_MAGIC => ("fuse", false),
        magics::OVERLAYFS_SUPER_MAGIC => ("overlayfs", false),
        magics::TMPFS_MAGIC => ("tmpfs", false),
        _ => ("ok", true),
    };
    if !supported {
        // The literal hex magic is the operator's grep key for matching
        // unfamiliar filesystems against `linux/magic.h` later.
        eprintln!(
            "{{\"level\":\"warn\",\"event\":\"pidfile_unsupported_filesystem\",\"path\":{:?},\"fs\":\"{}\",\"magic\":\"0x{:x}\"}}",
            parent.to_string_lossy(),
            label,
            (f_type as u64),
        );
        eprintln!(
            "pt-serve: WARNING — pidfile parent {:?} is on {} (magic 0x{:x}); flock semantics may not be reliable.",
            parent, label, (f_type as u64)
        );
    }
}

/// macOS no-op. pt-serve targets Linux production; the dev platform check
/// is skipped to avoid maintaining a parallel fstypename→support-class
/// table. Operators who run pt-serve on non-Linux production are off-spec
/// regardless.
#[cfg(not(target_os = "linux"))]
fn warn_on_unsupported_filesystem(_parent: &Path) {}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Happy path: acquire, file exists, contains our PID, drop releases.
    #[test]
    fn acquire_writes_pid_and_drop_removes_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("pt-serve.pid");

        let guard = acquire(&path).expect("acquire");
        // File exists, contains our PID + newline.
        let contents = std::fs::read_to_string(&path).expect("read pidfile");
        assert_eq!(contents.trim(), std::process::id().to_string());
        drop(guard);
        assert!(
            !path.exists(),
            "pidfile must be removed on drop (RAII courtesy unlink)"
        );
    }

    /// Two concurrent acquires of the same path. The second sees AlreadyLocked
    /// with the first's PID populated. After the first drops, a third acquire
    /// succeeds.
    #[test]
    fn second_acquire_observes_already_locked_with_existing_pid() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("pt-serve.pid");

        let first = acquire(&path).expect("first acquire");
        let err = acquire(&path).expect_err("second must fail");
        match err {
            PidfileError::AlreadyLocked { existing_pid } => {
                // Within a single process, the first acquire wrote OUR PID;
                // the read-back must agree. (In the process-level test we
                // use distinct child PIDs.)
                assert_eq!(existing_pid, Some(std::process::id()));
            }
            other => panic!("expected AlreadyLocked, got {other:?}"),
        }
        drop(first);
        let third = acquire(&path).expect("third acquire after drop");
        drop(third);
    }

    /// `read_existing_pid` returns None on empty / corrupt / missing files.
    #[test]
    fn read_existing_pid_tolerates_garbage() {
        let dir = tempfile::TempDir::new().unwrap();
        let p = dir.path().join("p");
        assert_eq!(read_existing_pid(&p), None, "missing → None");
        std::fs::write(&p, b"").unwrap();
        assert_eq!(read_existing_pid(&p), None, "empty → None");
        std::fs::write(&p, b"notanumber\n").unwrap();
        assert_eq!(read_existing_pid(&p), None, "garbage → None");
        std::fs::write(&p, b"42\n").unwrap();
        assert_eq!(read_existing_pid(&p), Some(42), "valid → Some(42)");
        std::fs::write(&p, b"   42  \nrest\n").unwrap();
        assert_eq!(read_existing_pid(&p), Some(42), "trimmed first line");
    }

    /// `InvalidParent` covers the no-parent path (empty parent component).
    #[test]
    fn empty_parent_is_invalid_parent() {
        // A bare filename like "x.pid" has Some("") as parent in some
        // contexts; explicitly hand acquire() a path with an empty parent
        // string to exercise the guard.
        let bad = PathBuf::from("x.pid");
        match acquire(&bad) {
            Err(PidfileError::InvalidParent(_)) => {}
            Err(PidfileError::Io(_)) => {
                // Some test runners' cwd is writable; in that case the
                // acquire would actually succeed. Skip if so — the unit
                // test's job is to cover the InvalidParent branch when the
                // path shape triggers it.
            }
            other => panic!("expected InvalidParent or Io, got {other:?}"),
        }
    }
}
