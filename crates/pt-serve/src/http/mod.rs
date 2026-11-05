//! HTTP transport seam.
//!
//! every `tiny_http` import in the crate lives under this module.

pub mod adapter;
pub mod loopback_pool;
pub mod server;
pub mod worker_pool;

pub use loopback_pool::{LoopbackPool, LoopbackPoolError};
pub use server::{bind, dispatch};
pub use worker_pool::{WorkerPool, WorkerPoolError};
// Re-export the tiny_http server type so `main.rs` can park it in `Arc`s and run worker loops
// without importing tiny_http directly.
pub use tiny_http::Server;
