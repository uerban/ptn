#!/usr/bin/env python3
"""Check an operator-selected generation through export, discovery and offline serving.

Uses a new private working directory and ephemeral test signing keys. This does
not accept feed provenance, publish a public endpoint or impose a memory limit.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request


def digest(data):
    return hashlib.sha256(data).hexdigest()


def execute(binary_dir, name, *args):
    result = subprocess.run([str(binary_dir / name), *map(str, args)],
                            capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise RuntimeError(f"{name} failed: {result.stderr}")
    return result.stdout.strip()


def request(port, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body,
                                 headers={"Accept-Encoding": "identity", "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.code, response.read()


def probe(binary_dir, work, store, inventory, key, manifest, plan):
    runtime = work / ("runtime-full" if inventory["geometrySelected"] else "runtime-minimal")
    runtime.mkdir()
    sockets = [socket.socket() for _ in range(3)]
    try:
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        ports = [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()
    args = [str(binary_dir / "pt-serve"), "--transit-store-root", str(store),
            "--transit-trusted-key", key, "--city-slug", inventory["city"],
            "--data-root", str(runtime), "--pidfile-path", str(runtime / "serve.pid"),
            "--listen-addr", f"127.0.0.1:{ports[0]}",
            "--metrics-listen-addr", f"127.0.0.1:{ports[1]}",
            "--loopback-listen-addr", f"127.0.0.1:{ports[2]}",
            "--max-rss-bytes", "2147483648", "--process-fixed-overhead-bytes", "200000000",
            "--per-worker-overhead-bytes", "50000000", "--page-warm-mode", "off"]
    checked = {}
    with (runtime / "server.log").open("wb") as log:
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith("PT_SERVE_") and key != "PT_DATA_ROOT_ID"}
        server = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, env=environment)
        try:
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if server.poll() is not None:
                    raise RuntimeError(f"server exited; inspect {runtime / 'server.log'}")
                try:
                    if request(ports[1], "/ready")[0] == 200:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError("server readiness timed out")
            prefix = f"/api/{inventory['city']}"
            for artifact in inventory["files"]:
                kind, path = artifact["kind"], artifact["path"]
                if kind == "ptb":
                    route = prefix + "/raptor-bundle"
                elif kind == "pedestrian-transfers-ptft":
                    route = prefix + "/transfers/fetch"
                elif kind == "schedule-tile":
                    route = prefix + "/gtfs/schedule-tile/" + path.removeprefix("schedule-tiles/").removesuffix(".br")
                else:
                    continue
                status, body = request(ports[0], route)
                if status != 200 or digest(body) != artifact["sha256"]:
                    raise RuntimeError(f"served artifact differs: {path} (HTTP {status})")
                checked[path] = digest(body)
            shapes = manifest.get("shapesJsonSha256")
            if shapes:
                status, body = request(ports[0], prefix + f"/gtfs/shapes/shapes-{shapes}.json")
                if inventory["geometrySelected"]:
                    if status != 200 or digest(body) != shapes:
                        raise RuntimeError("full geometry response differs")
                elif status != 503:
                    raise RuntimeError("geometry-free selection unexpectedly serves shapes")
            plan_hash = None
            if plan is not None:
                status, body = request(ports[0], prefix + "/plan", plan)
                result = json.loads(body)
                if status != 200 or not isinstance(result, list) or not result:
                    raise RuntimeError(f"plan probe returned no itineraries (HTTP {status})")
                plan_hash = digest(json.dumps(result, sort_keys=True, separators=(",", ":")).encode())
            return {"servedArtifacts": checked, "planSha256": plan_hash}
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generation", type=Path, required=True)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--work-directory", type=Path, required=True, help="new directory; retained for inspection")
    parser.add_argument("--plan-request", type=Path, help="optional accepted POST /plan JSON; requires nonempty identical results")
    parser.add_argument("--openssl", default="openssl", help="OpenSSL with Ed25519 support")
    args = parser.parse_args()
    work, binaries = args.work_directory.resolve(), args.bin_dir.resolve()
    work.mkdir(mode=0o700, parents=False, exist_ok=False)
    generation = args.generation.resolve()
    manifest = json.loads((generation / "generation.json").read_text())
    pack = json.loads((generation / "pack.json").read_text())
    city = pack["citySlug"]
    seed = secrets.token_bytes(32)
    # RFC 8410 PKCS#8 wrapper for an Ed25519 seed; OpenSSL derives only its public key.
    private = work / "test-key.der"
    signing = work / "test-seed.hex"
    private.write_bytes(bytes.fromhex("302e020100300506032b657004220420") + seed)
    signing.write_text(seed.hex())
    private.chmod(0o600)
    signing.chmod(0o600)
    try:
        public = subprocess.run([args.openssl, "pkey", "-inform", "DER", "-in", str(private),
                                 "-pubout", "-outform", "DER"], check=True, capture_output=True, timeout=30).stdout
        if len(public) != 44 or public[:12] != bytes.fromhex("302a300506032b6570032100"):
            raise RuntimeError("unexpected Ed25519 public key encoding")
        key = public[12:].hex()
        inventories = []
        for geometry in (False, True):
            extra = [] if geometry else ["--without-geometry"]
            inventory = json.loads(execute(binaries, "pt-pack-inspect", "--generation", generation, "--native", *extra))
            inventories.append(inventory)
            execute(binaries, "pt-pack-export", "--generation", generation, "--output", work / str(geometry),
                    "--signing-key", signing, *extra)
        expiry = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        repository = work / "repository"
        execute(binaries, "pt-pack-publish", "--repository", repository, "--city", city,
                "--selection", work / "False", "--selection", work / "True", "--expires-at", expiry,
                "--signing-key", signing, "--trusted-key", key)
        execute(binaries, "pt-pack-discovery", "--repository", repository, "--city", city,
                "--expires-at", expiry, "--signing-key", signing, "--trusted-key", key)
    finally:
        private.unlink(missing_ok=True)
        signing.unlink(missing_ok=True)
    store = work / "consumer"
    common = ["--root", store, "--city", city, "--trusted-key", key]
    plan = args.plan_request.read_bytes() if args.plan_request else None
    results = []
    for inventory in inventories:
        extra = [] if inventory["geometrySelected"] else ["--without-geometry"]
        execute(binaries, "pt-transit", *common, "sync", "--source-directory", repository / "public", "--from-discovery", *extra)
        # Make the source unavailable during validation and every server startup.
        unavailable = work / "repository-offline"
        repository.rename(unavailable)
        try:
            execute(binaries, "pt-transit", *common, "verify")
            results.append(probe(binaries, work, store, inventory, key, manifest, plan))
        finally:
            unavailable.rename(repository)
    if results[0] != results[1]:
        raise RuntimeError("full/minimal transit responses differ")
    before = execute(binaries, "pt-transit", *common, "status")
    listing = repository / "public/transit/discovery/v1/latest.json"
    original = listing.read_bytes()
    try:
        listing.write_bytes(original + b" ")  # Invalidates its authenticated byte identity.
        try:
            execute(binaries, "pt-transit", *common, "sync", "--source-directory",
                    repository / "public", "--from-discovery")
        except RuntimeError:
            pass
        else:
            raise RuntimeError("tampered discovery was accepted")
        if execute(binaries, "pt-transit", *common, "status") != before:
            raise RuntimeError("rejected discovery changed city activation")
    finally:
        listing.write_bytes(original)
    execute(binaries, "pt-transit", *common, "rollback")
    state = json.loads(execute(binaries, "pt-transit", *common, "status"))
    if state["current"]["geometrySelected"] or not state["pinned"]:
        raise RuntimeError("rollback did not restore and pin the minimal selection")
    repository.rename(work / "repository-offline")
    execute(binaries, "pt-transit", *common, "verify")
    binary_hashes = {}
    for name in ("pt-pack-inspect", "pt-pack-export", "pt-pack-publish", "pt-pack-discovery", "pt-transit", "pt-serve"):
        hasher = hashlib.sha256()
        with (binaries / name).open("rb") as stream:
            for chunk in iter(lambda: stream.read(65536), b""):
                hasher.update(chunk)
        binary_hashes[name] = hasher.hexdigest()
    report = {"schemaVersion": 1, "passed": True, "city": city, "packId": pack["packId"],
              "generationId": pack["generationId"], "variants": [{"geometrySelected": i["geometrySelected"],
              "selectedBytes": i["selectedBytes"], "files": len(i["files"])} for i in inventories],
              "checks": results[0], "rollbackPinned": True, "offlineStartup": True,
              "rejectedUpdatePreservesActivation": True, "binarySha256": binary_hashes,
              "transport": "local-directory", "memoryConstrained": False}
    (work / "evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    print(work / "evidence.json")


if __name__ == "__main__":
    main()
