use super::WriteRegion;
use crate::error::Result;
use crate::layout::{Layout, Region};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct BufWriterImpl {
    path: PathBuf,
    buffer: Vec<u8>,
}

pub fn open(path: &Path, total_bytes: u64) -> Result<BufWriterImpl> {
    Ok(BufWriterImpl {
        path: path.to_path_buf(),
        buffer: vec![0u8; total_bytes as usize],
    })
}

impl WriteRegion for BufWriterImpl {
    fn region_slice(&mut self, layout: &Layout, region: Region) -> &mut [u8] {
        let off = layout.offset(region) as usize;
        let len = layout.length(region) as usize;
        &mut self.buffer[off..off + len]
    }
    fn finish(self) -> Result<()> {
        let f = File::create(&self.path)?;
        let mut bw = std::io::BufWriter::new(f);
        bw.write_all(&self.buffer)?;
        let f = bw
            .into_inner()
            .map_err(|e| crate::Error::Io(e.into_error()))?;
        f.sync_all()?;
        Ok(())
    }
}
