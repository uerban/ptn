use crate::error::Result;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use tiny_http::{Response, Server};

pub struct ReadinessServer {
    ready: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    shutdown: Arc<AtomicBool>,
    server: Arc<Server>,
}

impl ReadinessServer {
    pub fn spawn(addr: SocketAddr) -> Result<Self> {
        let server = Arc::new(
            Server::http(addr).map_err(|e| crate::Error::Http(format!("bind {addr}: {e}")))?,
        );
        let ready = Arc::new(AtomicBool::new(false));
        let shutdown = Arc::new(AtomicBool::new(false));
        let ready_clone = ready.clone();
        let shutdown_clone = shutdown.clone();
        let server_clone = server.clone();
        let handle = std::thread::Builder::new()
            .name("pt-producer-http".into())
            .spawn(move || {
                while !shutdown_clone.load(Ordering::SeqCst) {
                    match server_clone.recv_timeout(std::time::Duration::from_millis(100)) {
                        Ok(Some(req)) => {
                            let (status, body): (u16, &'static str) = match req.url() {
                                "/api/health/ready" => {
                                    if ready_clone.load(Ordering::SeqCst) {
                                        (200, "ready\n")
                                    } else {
                                        (503, "not ready\n")
                                    }
                                }
                                "/api/health/live" => (200, "live\n"),
                                _ => (404, "not found\n"),
                            };
                            let _ =
                                req.respond(Response::from_string(body).with_status_code(status));
                        }
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| crate::Error::Http(format!("spawn http thread: {e}")))?;
        Ok(Self {
            ready,
            handle: Some(handle),
            shutdown,
            server,
        })
    }

    pub fn ready_flag(&self) -> &Arc<AtomicBool> {
        &self.ready
    }

    pub fn shutdown(mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.server.unblock();
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for ReadinessServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.server.unblock();
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}
