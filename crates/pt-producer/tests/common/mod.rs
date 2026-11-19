use std::io::{BufRead, BufReader};
use std::net::SocketAddr;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

pub fn spawn_on_ephemeral_port(command: &mut Command) -> (Child, SocketAddr) {
    let mut child = command
        .args(["--listen-addr", "127.0.0.1:0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn producer");

    let stdout = child.stdout.take().expect("producer stdout");
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let mut stdout = BufReader::new(stdout);
        let result = stdout.read_line(&mut line).map(|_| line);
        let _ = send.send(result);
        // Keep draining stdout until exit so the child can continue writing.
        let _ = std::io::copy(&mut stdout, &mut std::io::sink());
    });

    let startup = receive.recv_timeout(Duration::from_secs(15));
    let addr = startup
        .as_ref()
        .ok()
        .and_then(|result| result.as_ref().ok())
        .and_then(|line| line.trim_end().strip_prefix("[producer] readiness_listen="))
        .and_then(|address| address.parse::<SocketAddr>().ok())
        .filter(|addr| addr.port() != 0);
    if let Some(addr) = addr {
        return (child, addr);
    }

    let _ = child.kill();
    let output = child.wait_with_output().expect("collect producer output");
    panic!(
        "producer did not report its bound readiness address: {startup:?}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
