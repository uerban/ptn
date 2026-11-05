#!/usr/bin/env python3
"""Bootstrap, refresh, and serve the reference Vilnius deployment."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("command", choices=("refresh", "serve", "refresh-loop"))
    args = parser.parse_args()
    if args.command == "refresh-loop":
        while True:
            result = subprocess.run([sys.executable, __file__, "--config", str(args.config), "refresh"])
            print(f"PTN refresh exit={result.returncode}; retrying in one hour", flush=True)
            time.sleep(3600)
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text())
    root = Path(__file__).resolve().parents[2]
    state = (config_path.parent / config["stateDirectory"]).resolve()
    binary_dir = root / "bin"
    state.mkdir(parents=True, exist_ok=True)
    data = state / "transit"
    data.mkdir(exist_ok=True)
    runtime = state / "run"
    runtime.mkdir(exist_ok=True)
    # Keep the standard pool/cache settings. These are capacity allowances,
    # not measured memory guarantees for an arbitrary feed.
    serve_args = [str(binary_dir / "pt-serve"),
        "--city-slug=vilnius", "--city-tz-iana-default=Europe/Vilnius",
        # The producer's legacy signal lookup is <data-root>/pt-serve.pid.
        # Keep this lock elsewhere: a PID from another container namespace
        # could identify the updater itself. Adoption uses the server's poller.
        f"--data-root={data}", f"--pidfile-path={runtime / 'pt-serve.pid'}",
        f"--listen-addr={config.get('listenAddress', '127.0.0.1:9000')}",
        f"--metrics-listen-addr={config.get('auxAddress', '127.0.0.1:9001')}",
        f"--loopback-listen-addr={config.get('internalAddress', '127.0.0.1:9002')}",
        "--max-rss-bytes=2147483648", "--process-fixed-overhead-bytes=200000000",
        "--per-worker-overhead-bytes=50000000",
        f"--poi-bundle-dir={state / 'artifacts/public/poi/current'}",
        f"--poi-lease-root={state / 'leases'}"]
    rt = config.get("tripUpdatesURL")
    if rt:
        serve_args.append(f"--rt-trip-updates-urls={rt}")
    if args.command == "serve":
        os.execv(serve_args[0], serve_args)
    # Serialize the entire update, including artifact activation and feed fetch.
    with (state / "refresh.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source = config["artifactSource"]
        keys = config["trustedKeys"]
        if not keys:
            raise ValueError("configure at least one trusted OSM signing key")
        manager = state / "artifact-manager.json"
        manager.write_text(json.dumps({
            "root": str(state / "artifacts"), "source": source,
            "trustedKeys": keys,
            "cities": {"vilnius": {"required": ["walking", "addresses", "walkGraph", "poi"]}},
        }))
        subprocess.run([str(binary_dir / "pt-artifacts"), "--config", str(manager), "sync"], check=True)
        url = config["gtfsURL"]
        if not url.startswith("https://"):
            raise ValueError("gtfsURL must use HTTPS")
        feed = state / "vilnius.zip"
        # A failed/partial download must leave the prior feed and generation intact.
        temporary = None
        try:
            with urllib.request.urlopen(url, timeout=60) as response, tempfile.NamedTemporaryFile(dir=state, delete=False) as output:
                temporary = Path(output.name)
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    if count > 128 * 1024 * 1024:
                        raise ValueError("GTFS archive exceeds 128 MiB reference-city limit")
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            with zipfile.ZipFile(temporary) as archive:
                if archive.testzip() is not None:
                    raise ValueError("corrupt GTFS archive")
            temporary.replace(feed)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        if not (data / "pt-serve.version").exists():
            # On an empty root the server advertises its reader version before
            # rejecting the absent generation. Never manufacture this sentinel.
            seed = subprocess.run(serve_args, capture_output=True, text=True, timeout=30)
            if not (data / "pt-serve.version").is_file():
                raise RuntimeError(f"reader bootstrap failed: {seed.stdout}\n{seed.stderr}")
        subprocess.run([str(binary_dir / "pt-producer"), "republish",
            "--data-root", str(data), "--city", "vilnius",
            "--city-tz-iana", "Europe/Vilnius", "--from-cache", str(feed),
            "--osm-artifact-root", str(state / "artifacts"),
            "--osm-lease-root", str(state / "leases"),
            "--max-retained-generations", "3"], check=True,
            env={**os.environ, "PT_COLOR_BUILD": "rust", "PT_TILE_BUILD": "rust"})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"PTN: {error}", file=sys.stderr)
        sys.exit(1)
