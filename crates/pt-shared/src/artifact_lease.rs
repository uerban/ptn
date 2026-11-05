//! Process-lifetime pins for immutable installed artifacts. Mount this small
//! acknowledgement directory writable, separately from read-only artifact data.
//! Never unlink lock files: their stable inodes define the lock namespace.
//!
//! Resolve an activation while holding ResolutionGuard, acquire its release
//! lease, then drop the resolution guard. A collector holds CollectionGuard
//! throughout reference inspection and deletion. This closes the resolve/pin
//! race. Process exit/crash releases locks; PID reuse, restarts and wall-clock
//! jumps cannot manufacture a live lease or expire a live consumer.
use crate::osm_manifest::valid_digest;
use rustix::fs::{flock, FlockOperation, OFlags};
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

fn lock_file(path: &Path, create: bool) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(create)
        .truncate(false)
        .custom_flags(OFlags::NOFOLLOW.bits() as i32)
        .open(path)
}
#[derive(Debug)]
struct FileLock(File);

impl FileLock {
    fn acquire(file: File, operation: FlockOperation) -> io::Result<Self> {
        flock(&file, operation)?;
        Ok(Self(file))
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // Closing alone retains the lock while a forked child holds a duplicate
        // descriptor (even with close-on-exec). Release at the owner's lifetime
        // boundary instead of waiting for every inherited descriptor to close.
        let _ = flock(&self.0, FlockOperation::Unlock);
    }
}

fn gate(root: &Path, operation: FlockOperation) -> io::Result<FileLock> {
    fs::create_dir_all(root)?;
    let file = lock_file(&root.join("gate.lock"), true)?;
    FileLock::acquire(file, operation)
}
fn release_path(root: &Path, release: &str) -> io::Result<PathBuf> {
    if !valid_digest(release) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid lease release identity",
        ));
    }
    Ok(root.join("releases").join(format!("{release}.lock")))
}

pub struct ResolutionGuard {
    root: PathBuf,
    _gate: FileLock,
}
#[derive(Debug)]
pub struct ConsumerLease {
    _release: FileLock,
}
impl ResolutionGuard {
    pub fn acquire(root: &Path) -> io::Result<Self> {
        Ok(Self {
            root: root.into(),
            _gate: gate(root, FlockOperation::LockShared)?,
        })
    }
    pub fn pin(&self, release: &str) -> io::Result<ConsumerLease> {
        let path = release_path(&self.root, release)?;
        fs::create_dir_all(path.parent().unwrap())?;
        let file = lock_file(&path, true)?;
        Ok(ConsumerLease {
            _release: FileLock::acquire(file, FlockOperation::LockShared)?,
        })
    }
}

pub struct CollectionGuard {
    root: PathBuf,
    _gate: FileLock,
}
impl CollectionGuard {
    /// Nonblocking: a busy resolution defers pruning, never serving/build work.
    pub fn try_acquire(root: &Path) -> io::Result<Self> {
        Ok(Self {
            root: root.into(),
            _gate: gate(root, FlockOperation::NonBlockingLockExclusive)?,
        })
    }
    pub fn is_live(&self, release: &str) -> io::Result<bool> {
        let file = match lock_file(&release_path(&self.root, release)?, false) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        match FileLock::acquire(file, FlockOperation::NonBlockingLockExclusive) {
            Ok(_probe) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(true),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osm_manifest::digest;

    #[test]
    fn resolution_and_collection_exclude_each_other_then_leases_protect_consumers() {
        let dir = tempfile::tempdir().unwrap();
        let release = digest(b"release");
        let resolving = ResolutionGuard::acquire(dir.path()).unwrap();
        assert!(CollectionGuard::try_acquire(dir.path()).is_err());
        let first = resolving.pin(&release).unwrap();
        let second = resolving.pin(&release).unwrap();
        drop(resolving);
        let collecting = CollectionGuard::try_acquire(dir.path()).unwrap();
        assert!(collecting.is_live(&release).unwrap());
        drop(first);
        assert!(collecting.is_live(&release).unwrap());
        drop(second);
        assert!(!collecting.is_live(&release).unwrap());
        assert!(!collecting.is_live(&digest(b"never pinned")).unwrap());
        assert!(collecting.is_live("../escape").is_err());
    }

    #[test]
    fn dropping_guards_releases_locks_even_with_duplicate_descriptors() {
        let dir = tempfile::tempdir().unwrap();
        let release = digest(b"release");
        let resolving = ResolutionGuard::acquire(dir.path()).unwrap();
        let inherited_resolution = resolving._gate.0.try_clone().unwrap();
        let lease = resolving.pin(&release).unwrap();
        let inherited_lease = lease._release.0.try_clone().unwrap();
        drop(resolving);

        let collecting = CollectionGuard::try_acquire(dir.path()).unwrap();
        assert!(collecting.is_live(&release).unwrap());
        drop(lease);
        assert!(!collecting.is_live(&release).unwrap());

        let inherited_collection = collecting._gate.0.try_clone().unwrap();
        drop(collecting);
        let _collecting = CollectionGuard::try_acquire(dir.path()).unwrap();
        drop((inherited_resolution, inherited_lease, inherited_collection));
    }

    #[test]
    fn stale_files_do_not_pin_releases_and_symlinks_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let release = digest(b"stale");
        let resolving = ResolutionGuard::acquire(dir.path()).unwrap();
        assert!(resolving.pin("bad").is_err());
        drop(resolving.pin(&release).unwrap());
        drop(resolving);
        let collecting = CollectionGuard::try_acquire(dir.path()).unwrap();
        assert!(!collecting.is_live(&release).unwrap());
        let other = digest(b"symlink");
        std::os::unix::fs::symlink("/dev/null", release_path(dir.path(), &other).unwrap()).unwrap();
        assert!(collecting.is_live(&other).is_err());
    }

    #[test]
    fn lease_process_child() {
        let Some(root) = std::env::var_os("PTN_LEASE_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let resolving = ResolutionGuard::acquire(&root).unwrap();
        let _lease = resolving.pin(&digest(b"child")).unwrap();
        drop(resolving);
        fs::write(root.join("ready"), b"ready").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[test]
    fn killed_consumer_releases_lease_without_timestamp_or_pid_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "artifact_lease::tests::lease_process_child"])
            .env("PTN_LEASE_TEST_ROOT", dir.path())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..200 {
            if dir.path().join("ready").exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !dir.path().join("ready").exists() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("lease child did not become ready");
        }
        let collecting = CollectionGuard::try_acquire(dir.path()).unwrap();
        let live = collecting.is_live(&digest(b"child")).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(live);
        assert!(!collecting.is_live(&digest(b"child")).unwrap());
    }
}
