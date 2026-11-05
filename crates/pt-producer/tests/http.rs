use pt_producer::http::ReadinessServer;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::time::Duration;

fn pick_free_port() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

fn http_get(addr: SocketAddr, path: &str) -> u16 {
    let req = format!("GET {} HTTP/1.0\r\nHost: x\r\n\r\n", path);
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream.write_all(req.as_bytes()).unwrap();
    let mut buf = String::new();
    stream.read_to_string(&mut buf).unwrap();
    let status_line = buf.lines().next().expect("response had no status line");
    status_line
        .split_whitespace()
        .nth(1)
        .expect("status line missing code")
        .parse()
        .expect("status code not numeric")
}

#[test]
fn ready_returns_503_then_200_after_flip() {
    let addr = pick_free_port();
    let server = ReadinessServer::spawn(addr).unwrap();

    assert_eq!(http_get(addr, "/api/health/ready"), 503);
    assert_eq!(http_get(addr, "/api/health/live"), 200);

    server.ready_flag().store(true, Ordering::SeqCst);
    assert_eq!(http_get(addr, "/api/health/ready"), 200);

    assert_eq!(http_get(addr, "/wat"), 404);

    server.shutdown();
}

#[test]
fn liveness_is_independent_of_readiness() {
    let addr = pick_free_port();
    let server = ReadinessServer::spawn(addr).unwrap();
    assert_eq!(http_get(addr, "/api/health/live"), 200);
    assert_eq!(http_get(addr, "/api/health/ready"), 503);
    assert_eq!(http_get(addr, "/api/health/live"), 200);
    server.shutdown();
}
