use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("http fetch failed: {0}")]
    Http(String),

    #[error("zip error: {0}")]
    Zip(String),

    #[error("malformed gtfs: {0}")]
    MalformedGtfs(String),

    #[error("missing required file: {0}")]
    MissingFile(String),

    #[error("csv error: {0}")]
    Csv(#[from] csv::Error),

    #[error("config error: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, Error>;
