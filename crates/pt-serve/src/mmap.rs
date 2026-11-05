use memmap2::Mmap;
use std::sync::Arc;

/// `Reader<B>` requires `B: AsRef<[u8]> + Send + Sync + 'static`. `Arc<Mmap>` is
/// Send+Sync+'static but its `AsRef` impl yields `&Mmap`. This newtype yields `&[u8]`.
#[derive(Clone)]
pub struct MmapBytes(pub Arc<Mmap>);

impl AsRef<[u8]> for MmapBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0[..]
    }
}

/// mmap a file read-only. P3 is single-generation: no madvise/unmap path (that is P4).
pub fn open_mmap(path: &std::path::Path) -> std::io::Result<MmapBytes> {
    Ok(open_mmap_with_mtime(path)?.0)
}

/// mmap a file read-only AND return its mtime (nanos since the UNIX epoch, 0 if
/// unavailable), both derived from the SAME open file descriptor. Reading mtime via a
/// second path lookup would be a TOCTOU race: an atomic-replace between the map and the
/// stat could pair the old file's bytes with the new file's mtime, recreating the false-304
/// the ETag's mtime term exists to prevent (state.rs `bundle_etag` doc). fstat-ing the fd we
/// already mapped guarantees bytes and mtime come from one inode.
pub fn open_mmap_with_mtime(path: &std::path::Path) -> std::io::Result<(MmapBytes, u128)> {
    let file = std::fs::File::open(path)?;
    // fstat the open fd (not a fresh path lookup) so mtime matches the mapped inode.
    let mtime_nanos = file
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // SAFETY: read-only map backed by a static PTB artifact. This process does not
    // write the file. External modification during the map's lifetime is UB per the
    // memmap2 contract and is an operator responsibility (atomic-replace + restart is
    // the expected update path). The reload runner's no-op precheck re-hashes the
    // on-disk bytes against the manifest (reload/runner.rs run_one_inner), so an
    // in-place rewrite that keeps the pointer unchanged is detected at the next
    // reload trigger rather than silently served.
    let mmap = unsafe { Mmap::map(&file)? };
    Ok((MmapBytes(Arc::new(mmap)), mtime_nanos))
}
