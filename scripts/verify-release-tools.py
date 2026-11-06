#!/usr/bin/env python3
"""Execute packaged tools natively or with a supplied QEMU user-mode runner."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import ssl
import subprocess
import tempfile
import threading


def verify_native_tls(runner, binaries, work):
    """Exercise ARMv6 native TLS; bundled-root rustls targets ignore SSL_CERT_FILE."""
    config = work / "openssl.cnf"
    config.write_text("""[req]
distinguished_name = dn
x509_extensions = extensions
prompt = no
[dn]
CN = localhost
[extensions]
subjectAltName = DNS:localhost
basicConstraints = critical,CA:TRUE
""")
    cert, key = work / "ca.pem", work / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-days", "1", "-config", str(config), "-keyout", str(key), "-out", str(cert)],
        check=True, capture_output=True, timeout=30)
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_error(404)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"https://localhost:{server.server_port}"
    environment = {**os.environ, "SSL_CERT_FILE": str(cert), "SSL_CERT_DIR": str(work)}
    artifact_config = work / "artifacts.json"
    artifact_config.write_text(json.dumps({"root": str(work / "artifacts"),
        "source": {"kind": "https", "url": url}, "trustedKeys": ["11" * 32],
        "cities": {"vilnius": {}}}))
    commands = [
        [str(binaries / "pt-transit"), "--root", str(work / "transit"),
         "--trusted-key", "11" * 32, "cities", "--source-url", url],
        [str(binaries / "pt-artifacts"), "--config", str(artifact_config), "sync"],
        [str(binaries / "pt-producer"), "--gtfs-url", url + "/feed.zip", "--listen-addr", "127.0.0.1:0"],
    ]
    try:
        for command in commands:
            before = len(requests)
            result = subprocess.run(runner + command, env=environment, capture_output=True,
                                    text=True, timeout=60)
            assert result.returncode != 0 and "404" in result.stderr, result.stderr
            assert len(requests) > before, f"{command[0]} did not reach the trusted HTTPS server"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    print("PASS: ARMv6 artifact, transit and GTFS clients completed trusted local TLS requests")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--runner", default="")
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    runner = shlex.split(args.runner)
    bundle = args.bundle.resolve()
    archive = bundle.with_suffix(".tar.gz")
    expected, filename = archive.with_suffix(".gz.sha256").read_text().split()
    assert filename == archive.name
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
    metadata = json.loads((bundle / "release.json").read_text())
    assert metadata["revision"] == args.revision and metadata["sourceDirty"] is False
    for line in (bundle / "SHA256SUMS").read_text().splitlines():
        expected, name = line.split("  ", 1)
        assert hashlib.sha256((bundle / name).read_bytes()).hexdigest() == expected, name
    binaries = bundle / "bin"
    for name in ("pt-serve", "pt-producer", "pt-build-transfers", "pt-artifacts", "pt-artifact-publish", "pt-transit", "pt-pack-inspect",
                 "pt-pack-export", "pt-pack-catalog", "pt-pack-publish", "pt-pack-discovery"):
        result = subprocess.run(runner + [str(binaries / name), "--help"],
                                check=True, capture_output=True, text=True, timeout=60)
        assert "Usage:" in result.stdout, (name, result.stdout)
    # This tool's --help exits nonzero; exercise a real graph build instead.
    with tempfile.TemporaryDirectory() as work:
        work = Path(work)
        source = work / "ways.geojsonseq"
        source.write_text(json.dumps({"type": "Feature", "geometry": {
            "type": "LineString", "coordinates": [[25.28, 54.68], [25.281, 54.68]]},
            "properties": {"highway": "footway"}}) + "\n")
        graph = work / "walk.ptwg"
        result = subprocess.run(runner + [str(binaries / "pt-walk-build"), "--input", str(source),
            "--city", "vilnius", "--generated-at", "2026-11-05", "--out", str(graph)],
            check=True, capture_output=True, text=True, timeout=60)
        stats = json.loads(result.stdout)
        assert stats["nodes"] == 2 and stats["edges"] == 1, stats
        assert graph.read_bytes()[:4] == b"PTWG"
        if metadata["rustTarget"] == "arm-unknown-linux-musleabihf":
            verify_native_tls(runner, binaries, work)
    print("PASS: all twelve packaged native tools execute; walking graph fixture built")


if __name__ == "__main__":
    main()
