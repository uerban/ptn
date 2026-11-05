#!/usr/bin/env python3
"""Validate the reference Compose files with a fresh, isolated project."""
import argparse
import json
import os
from pathlib import Path
import shlex
import socket
import ssl
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-config", type=Path, required=True)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--compose", default="docker compose")
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    source = json.loads(args.source_config.read_text())
    if source["artifactSource"]["kind"] != "local":
        parser.error("the reference lifecycle test requires a local signed catalog")
    config_dir = evidence / "config"
    config_dir.mkdir()
    config = json.loads((ROOT / "examples/native/config.example.json").read_text())
    config.update(source)
    config.update(stateDirectory="/var/lib/ptn", listenAddress="0.0.0.0:9000", auxAddress="0.0.0.0:9001")
    config["artifactSource"] = {"kind": "local", "directory": "/osm-repository"}
    config.pop("tripUpdatesURL", None)
    (config_dir / "config.json").write_text(json.dumps(config))
    http_port, redirect_port, tls_port = [free_port() for _ in range(3)]
    environment = {**os.environ, "PTN_CONFIG_DIR": str(config_dir),
        "PTN_OSM_REPOSITORY": source["artifactSource"]["directory"],
        "PTN_HTTP_PORT": str(http_port), "PTN_PUBLIC_HTTP_PORT": str(redirect_port),
        "PTN_HTTPS_PORT": str(tls_port), "PTN_DOMAIN": "localhost"}
    command = shlex.split(args.compose) + ["-p", f"ptn-validation-{os.getpid()}", "-f", str(ROOT / "docker/compose.yml")]
    secure = []

    def run(tail, name, *, input=None, check=True):
        with (evidence / f"{name}.log").open("w") as log:
            return subprocess.run(command + secure + tail, cwd=ROOT, env=environment,
                input=input, text=True, stdout=log, stderr=subprocess.STDOUT, check=check)

    def ready(url, generation=None, context=None):
        last_error = None
        for _ in range(90):
            try:
                with urllib.request.urlopen(url + "/api/vilnius/ready", timeout=3, context=context) as response:
                    value = json.load(response)
                if value["status"] == "ready" and (generation is None or value["servingGenerationId"] == generation):
                    return value["servingGenerationId"]
            except (OSError, ValueError, KeyError) as error:
                last_error = error
            time.sleep(1)
        raise RuntimeError(f"Docker readiness/generation check timed out: {last_error}")

    def browser(url, name, local_ca=False):
        log_path = evidence / f"{name}.log"
        try:
            with log_path.open("w") as log:
                subprocess.run(["node", str(ROOT / "scripts/verify-hosting.mjs"), url,
                    str(args.probe.resolve()), str(evidence / name)], cwd=ROOT,
                    env={**os.environ, "PTN_TEST_LOCAL_CA": "1" if local_ca else "0"},
                    stdout=log, stderr=subprocess.STDOUT, check=True)
        except subprocess.CalledProcessError:
            print(log_path.read_text(), file=sys.stderr, flush=True)
            raise

    try:
        run(["config"], "resolved-config")
        run(["build", "transit"], "build")
        run(["run", "--rm", "transit", "refresh"], "bootstrap")
        run(["up", "-d"], "up")
        http = f"http://localhost:{http_port}"
        generation = ready(http)
        browser(http, "browser-http")
        fixture = (ROOT / "scripts/hosting_fixture.py").read_text()
        run(["exec", "-T", "transit", "python3", "-"], "changed-feed",
            input=fixture + "\nchange_stop_label('/var/lib/ptn/vilnius.zip', '/var/lib/ptn/changed.zip')\n")
        run(["exec", "-T", "-e", "PT_COLOR_BUILD=rust", "-e", "PT_TILE_BUILD=rust", "transit",
             "/opt/ptn/bin/pt-producer", "republish", "--data-root", "/var/lib/ptn/transit",
             "--city", "vilnius", "--city-tz-iana", "Europe/Vilnius", "--from-cache", "/var/lib/ptn/changed.zip",
             "--osm-artifact-root", "/var/lib/ptn/artifacts", "--osm-lease-root", "/var/lib/ptn/leases"], "republish")
        pointer = subprocess.check_output(command + ["exec", "-T", "transit", "cat", "/var/lib/ptn/transit/current.json"], env=environment)
        new_generation = json.loads(pointer)["generationId"]
        assert new_generation != generation
        ready(http, new_generation)
        # Run the updater in its own container namespace, as in production.
        # Its refresh must finish without signalling its own PID 1.
        run(["run", "--rm", "transit", "refresh"], "cross-namespace-refresh")
        restored_generation = ready(http, generation)
        run(["restart", "transit"], "restart")
        ready(http, restored_generation)
        browser(http, "browser-restarted")
        secure[:] = ["-f", str(ROOT / "docker/compose.https.yml")]
        run(["config"], "resolved-https-config")
        run(["up", "-d"], "up-https")
        ca_path = evidence / "root.crt"
        for _ in range(60):
            result = subprocess.run(command + secure + ["exec", "-T", "web", "cat", "/data/caddy/pki/authorities/local/root.crt"],
                env=environment, capture_output=True)
            if result.returncode == 0:
                ca_path.write_bytes(result.stdout)
                break
            time.sleep(1)
        https = f"https://localhost:{tls_port}"
        ready(https, restored_generation, ssl.create_default_context(cafile=str(ca_path)))
        browser(https, "browser-https", True)
        (evidence / "result.json").write_text(json.dumps({"http": True, "localCATLS": True,
            "reload": True, "crossNamespaceRefresh": True, "restart": True,
            "initialGeneration": generation, "newGeneration": new_generation}, indent=2) + "\n")
        print("PASS: Compose bootstrap, browser HTTP/TLS, reload, cross-namespace refresh, restart")
    finally:
        run(["logs", "--no-color", "--tail", "100"], "container-logs", check=False)
        run(["down", "--volumes", "--remove-orphans"], "cleanup", check=False)


if __name__ == "__main__":
    main()
