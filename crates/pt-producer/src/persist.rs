use crate::error::{Error, Result};
use std::path::Path;

/// Move `src` to `dest`, replacing any existing file at `dest`.
///
/// Tries `rename` first (atomic, same filesystem). On `EXDEV`
/// (cross-filesystem) falls back to copy + remove; the destination is
/// only created via `tempfile` in the same dir as `dest` and then
/// renamed in place so an interrupted persist never leaves a partially
/// written PTB at `dest`.
///
/// Parent directories of `dest` are created with `mkdir -p`.
pub fn persist_artifact(src: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                Error::Config(format!("persist: mkdir -p {}: {e}", parent.display()))
            })?;
        }
    }

    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if is_exdev(&e) => persist_via_copy(src, dest),
        Err(e) => Err(Error::Config(format!(
            "persist: rename {} -> {}: {e}",
            src.display(),
            dest.display()
        ))),
    }
}

fn is_exdev(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(not(unix))]
    {
        let _ = e;
        false
    }
}

fn persist_via_copy(src: &Path, dest: &Path) -> Result<()> {
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let tmp = tempfile::Builder::new()
        .prefix(".ptnb-persist-")
        .tempfile_in(parent)
        .map_err(|e| Error::Config(format!("persist: tempfile in {}: {e}", parent.display())))?;
    std::fs::copy(src, tmp.path()).map_err(|e| {
        Error::Config(format!(
            "persist: copy {} -> {}: {e}",
            src.display(),
            tmp.path().display()
        ))
    })?;
    tmp.persist(dest).map_err(|e| {
        Error::Config(format!(
            "persist: rename tmp -> {}: {}",
            dest.display(),
            e.error
        ))
    })?;
    // Don't remove `src` — it lives inside the caller's tempdir, which
    // cleans itself up on Drop. A failed unlink here (read-only source FS,
    // already-gone file, etc.) would spuriously fail the whole persist
    // after the artifact is already safely at `dest`.
    Ok(())
}
