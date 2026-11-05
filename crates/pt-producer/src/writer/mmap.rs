use super::WriteRegion;
use crate::error::Result;
use crate::layout::{Layout, Region};
use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

pub struct MmapImpl {
    _file: std::fs::File,
    mmap: MmapMut,
    _path: PathBuf,
}

pub fn open(path: &Path, total_bytes: u64) -> Result<MmapImpl> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.set_len(total_bytes)?;
    let mmap = unsafe { MmapMut::map_mut(&file)? };
    Ok(MmapImpl {
        _file: file,
        mmap,
        _path: path.to_path_buf(),
    })
}

impl WriteRegion for MmapImpl {
    fn region_slice(&mut self, layout: &Layout, region: Region) -> &mut [u8] {
        let off = layout.offset(region) as usize;
        let len = layout.length(region) as usize;
        &mut self.mmap[off..off + len]
    }
    fn finish(self) -> Result<()> {
        self.mmap.flush()?;
        // madvise(MADV_DONTNEED) releases dirty pages before drop so the post-Pass-2 idle RSS
        // reflects the production end-state. Failure is the measurement the producer exists to take
        // — log loudly so a biased rssSteadyBytes number does not silently land in
        #[cfg(target_os = "linux")]
        {
            let rc = unsafe {
                libc::madvise(
                    self.mmap.as_ptr() as *mut libc::c_void,
                    self.mmap.len(),
                    libc::MADV_DONTNEED,
                )
            };
            if rc != 0 {
                let err = std::io::Error::last_os_error();
                eprintln!(
                    "[producer] WARN: madvise(MADV_DONTNEED) failed rc={rc} err={err}; \
                     idle RSS will run high and bias the measurement"
                );
            }
        }
        drop(self.mmap);
        Ok(())
    }
}
