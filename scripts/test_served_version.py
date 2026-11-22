"""Hosting validation must fail when the server reports a different version than its archive."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest

from served_version import check_served_version


def serve(body_version, header_version):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.path == "/api/vilnius/version"
            payload = json.dumps({"version": body_version}).encode()
            self.send_response(200)
            if header_version is not None:
                self.send_header("X-App-Version", header_version)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class ServedVersion(unittest.TestCase):
    def check(self, recorded, body, header):
        server = serve(body, header)
        try:
            with tempfile.TemporaryDirectory() as bundle:
                metadata = {"revision": "a" * 40} if recorded is None else {"version": recorded}
                (Path(bundle) / "release.json").write_text(json.dumps(metadata))
                return check_served_version(f"http://127.0.0.1:{server.server_port}", bundle)
        finally:
            server.shutdown()
            server.server_close()

    def test_matching_body_and_header(self):
        self.assertEqual(self.check("0.2.44", "0.2.44", "0.2.44"), "0.2.44")

    def test_mismatch_in_body_or_header_fails(self):
        for body, header in [("0.2.0-dev", "0.2.44"), ("0.2.44", "0.2.0-dev")]:
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                self.check("0.2.44", body, header)

    def test_missing_header_fails(self):
        with self.assertRaisesRegex(RuntimeError, "no X-App-Version header"):
            self.check("0.2.44", "0.2.44", None)

    def test_archive_without_version_is_not_checked(self):
        self.assertIsNone(self.check(None, "0.2.0-dev", "0.2.0-dev"))
