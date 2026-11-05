use crate::error::{Error, Result};
use std::io::Read;
use std::path::{Path, PathBuf};

pub fn extract_zip(zip_path: &Path, out_dir: &Path) -> Result<Vec<PathBuf>> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| Error::Zip(e.to_string()))?;
    let mut paths = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| Error::Zip(e.to_string()))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry
            .enclosed_name()
            .ok_or_else(|| Error::Zip("bad name".into()))?;
        let dest = out_dir.join(name.file_name().unwrap_or_default());
        let mut out = std::fs::File::create(&dest)?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = entry.read(&mut buf)?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut out, &buf[..n])?;
        }
        paths.push(dest);
    }
    Ok(paths)
}

pub fn extract_all(zip_paths: &[PathBuf], out_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut feed_dirs = Vec::with_capacity(zip_paths.len());
    for (i, zip) in zip_paths.iter().enumerate() {
        let sub = out_dir.join(format!("feed-{i}"));
        std::fs::create_dir_all(&sub)?;
        extract_zip(zip, &sub)?;
        feed_dirs.push(sub);
    }
    Ok(feed_dirs)
}
