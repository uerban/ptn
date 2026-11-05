use crate::error::Result;
use crate::layout::{Layout, Region};

pub trait WriteRegion {
    fn region_slice(&mut self, layout: &Layout, region: Region) -> &mut [u8];
    fn finish(self) -> Result<()>;
}

#[cfg(feature = "csv-bufwriter")]
mod bufwriter;
#[cfg(feature = "csv-bufwriter")]
pub use bufwriter::{open as open_writer, BufWriterImpl as ChosenWriter};

#[cfg(feature = "csv-mmap")]
mod mmap;
#[cfg(feature = "csv-mmap")]
pub use mmap::{open as open_writer, MmapImpl as ChosenWriter};
