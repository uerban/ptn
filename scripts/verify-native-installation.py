#!/usr/bin/env python3
"""Check an extracted release, including bootstrap, routing, TLS and reload."""
import argparse
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
import urllib.request
from hosting_fixture import change_stop_label

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--source-config", type=Path, required=True)
    parser.add_argument("--caddy", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    bundle, evidence = args.bundle.resolve(), args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    state = evidence / "state"
    if state.exists():
        parser.error("choose a new evidence directory for a fresh-root check")
    source = json.loads(args.source_config.read_text())
    config = json.loads((bundle / "examples/native/config.example.json").read_text())
    ports = [free_port() for _ in range(5)]
    main_port, aux_port, internal_port, http_port, tls_port = ports
    config.update(source)
    config.update(stateDirectory=str(state), listenAddress=f"127.0.0.1:{main_port}",
                  auxAddress=f"127.0.0.1:{aux_port}", internalAddress=f"127.0.0.1:{internal_port}")
    config.pop("tripUpdatesURL", None)
    config_path = evidence / "config.json"
    config_path.write_text(json.dumps(config))
    host = [sys.executable, str(bundle / "examples/native/host.py"), "--config", str(config_path)]
    processes = []

    def run(command, name, **kwargs):
        with (evidence / f"{name}.log").open("w") as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, **kwargs)

    def start(command, name, **kwargs):
        with (evidence / f"{name}.log").open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, **kwargs)
        processes.append(process)
        return process

    def ready(url, generation=None, context=None):
        last_error = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(url + "/api/vilnius/ready", timeout=3, context=context) as response:
                    value = json.load(response)
                if value["status"] == "ready" and (generation is None or value["servingGenerationId"] == generation):
                    return value["servingGenerationId"]
            except (OSError, ValueError, KeyError) as error:
                last_error = error
            time.sleep(1)
        raise RuntimeError(f"readiness/generation check timed out: {last_error}")

    try:
        run(host + ["refresh"], "bootstrap")
        server = start(host + ["serve"], "serve")
        environment = {**os.environ, "PTN_WEB_ROOT": str(bundle / "web"),
                       "PTN_ARTIFACT_PUBLIC": str(state / "artifacts/public"),
                       "PTN_MAIN": f"127.0.0.1:{main_port}", "PTN_AUX": f"127.0.0.1:{aux_port}",
                       "XDG_DATA_HOME": str(evidence / "caddy-data")}
        http = f"http://localhost:{http_port}"
        https = f"https://localhost:{tls_port}"
        start([args.caddy, "run", "--config", str(bundle / "examples/native/Caddyfile"), "--adapter", "caddyfile"], "web-http", env={**environment, "PTN_SITE": http})
        generation = ready(http)
        with (evidence / "probe.json").open("w") as output:
            subprocess.run([sys.executable, str(ROOT / "scripts/hosting-probe.py"), str(state / "vilnius.zip")], stdout=output, check=True)
        browser = ["node", str(ROOT / "scripts/verify-hosting.mjs")]
        run(browser + [http, str(evidence / "probe.json"), str(evidence / "browser-http")], "browser-http")
        # A private local CA exercises TLS without installing system trust or
        # requesting a public certificate for someone else's domain.
        tls_config = evidence / "Caddyfile.tls"
        tls_config.write_text((bundle / "examples/native/Caddyfile").read_text().replace("admin off", "admin off\n    auto_https disable_redirects"))
        start([args.caddy, "run", "--config", str(tls_config), "--adapter", "caddyfile"], "web-https", env={**environment, "PTN_SITE": https})
        ca = evidence / "caddy-data/caddy/pki/authorities/local/root.crt"
        for _ in range(30):
            if ca.exists():
                break
            time.sleep(1)
        assert ready(https, generation, ssl.create_default_context(cafile=str(ca))) == generation
        run(browser + [https, str(evidence / "probe.json"), str(evidence / "browser-https")], "browser-https", env={**os.environ, "PTN_TEST_LOCAL_CA": "1"})
        # Change one stop label in a private copy to produce a new bundle;
        # timetable records and the selected journey remain unchanged.
        changed = evidence / "changed.zip"
        change_stop_label(state / "vilnius.zip", changed)
        run([str(bundle / "bin/pt-producer"), "republish", "--data-root", str(state / "transit"),
             "--city", "vilnius", "--city-tz-iana", "Europe/Vilnius", "--from-cache", str(changed),
             "--osm-artifact-root", str(state / "artifacts"), "--osm-lease-root", str(state / "leases")],
            "republish", env={**os.environ, "PT_COLOR_BUILD": "rust", "PT_TILE_BUILD": "rust"})
        new_generation = json.loads((state / "transit/current.json").read_text())["generationId"]
        assert new_generation != generation
        ready(http, new_generation)
        config["gtfsURL"] = "https://127.0.0.1:1/unavailable.zip"
        config_path.write_text(json.dumps(config))
        with (evidence / "failed-refresh.log").open("w") as log:
            failure = subprocess.run(host + ["refresh"], stdout=log, stderr=subprocess.STDOUT)
        assert failure.returncode != 0
        assert ready(http, new_generation) == new_generation
        server.terminate()
        server.wait(timeout=20)
        start(host + ["serve"], "serve-restarted")
        assert ready(http, new_generation) == new_generation
        run(browser + [http, str(evidence / "probe.json"), str(evidence / "browser-restarted")], "browser-restarted")
        (evidence / "result.json").write_text(json.dumps({"bootstrap": True, "http": True, "localCATLS": True,
             "reload": True, "failedRefreshPreservedGeneration": True, "restart": True,
             "initialGeneration": generation, "newGeneration": new_generation}, indent=2) + "\n")
        print("PASS: extracted archive bootstrap, browser HTTP/TLS, reload, failed refresh, restart")
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    main()
