#!/usr/bin/env python3
"""Bootstrap, refresh, and serve the reference Vilnius deployment."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from gtfs import prepare
from catalog import publish_catalog, descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("command", choices=("refresh", "serve", "refresh-loop", "web-config"))
    args = parser.parse_args()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text())
    city = config.get("city", "vilnius")
    timezone = descriptor(config)["tz"]
    config.update(city=city, timezone=timezone)
    if args.command == "refresh-loop":
        while True:
            result = subprocess.run(
                [sys.executable, __file__, "--config", str(args.config), "refresh"]
            )
            interval = config.get("refreshIntervalSeconds", 3600)
            if not isinstance(interval, int) or interval < 60:
                raise ValueError("refreshIntervalSeconds must be an integer >= 60")
            print(
                f"PTN refresh exit={result.returncode}; retrying in {interval}s",
                flush=True,
            )
            time.sleep(interval)
    root = Path(__file__).resolve().parents[2]
    state = (config_path.parent / config["stateDirectory"]).resolve()
    binary_dir = root / "bin"
    state.mkdir(parents=True, exist_ok=True)
    data = state / "transit"
    data.mkdir(exist_ok=True)
    runtime = state / "run"
    runtime.mkdir(exist_ok=True)
    public_config = state / "public-config"
    publish_catalog([config], public_config)
    caddy = Path(__file__).with_name("Caddyfile").read_text().replace("vilnius", city)
    (public_config / "Caddyfile").write_text(caddy)
    if args.command == "web-config":
        print(public_config / "Caddyfile")
        return

    # Keep the standard pool/cache settings. These are capacity allowances,
    # not measured memory guarantees for an arbitrary feed.
    serve_args = [
        str(binary_dir / "pt-serve"),
        f"--city-slug={city}",
        f"--city-tz-iana-default={timezone}",
        # The producer's legacy signal lookup is <data-root>/pt-serve.pid.
        # Keep this lock elsewhere: a PID from another container namespace
        # could identify the updater itself. Adoption uses the server's poller.
        f"--data-root={data}",
        f"--pidfile-path={runtime / 'pt-serve.pid'}",
        f"--listen-addr={config.get('listenAddress', '127.0.0.1:9000')}",
        f"--metrics-listen-addr={config.get('auxAddress', '127.0.0.1:9001')}",
        f"--loopback-listen-addr={config.get('internalAddress', '127.0.0.1:9002')}",
        "--max-rss-bytes=2147483648",
        "--process-fixed-overhead-bytes=200000000",
        "--per-worker-overhead-bytes=50000000",
        f"--poi-bundle-dir={state / 'artifacts/public/poi/current'}",
        f"--poi-lease-root={state / 'leases'}",
    ]
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
        manager.write_text(
            json.dumps(
                {
                    "root": str(state / "artifacts"),
                    "source": source,
                    "trustedKeys": keys,
                    "cities": {
                        city: {"required": ["walking", "addresses", "walkGraph", "poi"]}
                    },
                }
            )
        )
        subprocess.run(
            [str(binary_dir / "pt-artifacts"), "--config", str(manager), "sync"],
            check=True,
        )
        prepared = prepare(
            config,
            state / "feeds",
            validator=Path(config["gtfsValidatorJar"]).resolve()
            if config.get("gtfsValidatorJar")
            else None,
        )
        if rt and any(feed["idPrefix"] for feed in prepared["feeds"]):
            raise ValueError(
                "multi-feed recipes require source-aware realtime ID mapping; omit tripUpdatesURL"
            )
        feed_args = [
            value
            for feed in prepared["feeds"]
            for value in ("--from-cache", feed["path"])
        ]
        if city == "vilnius" and len(prepared["feeds"]) == 1:
            import shutil

            shutil.copyfile(prepared["feeds"][0]["path"], state / "vilnius.zip")
        if not (data / "pt-serve.version").exists():
            # On an empty root the server advertises its reader version before
            # rejecting the absent generation. Never manufacture this sentinel.
            seed = subprocess.run(
                serve_args, capture_output=True, text=True, timeout=30
            )
            if not (data / "pt-serve.version").is_file():
                raise RuntimeError(
                    f"reader bootstrap failed: {seed.stdout}\n{seed.stderr}"
                )
        subprocess.run(
            [
                str(binary_dir / "pt-producer"),
                "republish",
                "--data-root",
                str(data),
                "--city",
                city,
                "--city-tz-iana",
                timezone,
                *feed_args,
                "--derive-inseat",
                prepared["deriveInseat"],
                "--osm-artifact-root",
                str(state / "artifacts"),
                "--osm-lease-root",
                str(state / "leases"),
                "--max-retained-generations",
                "3",
            ],
            check=True,
            env={**os.environ, "PT_COLOR_BUILD": "rust", "PT_TILE_BUILD": "rust"},
        )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"PTN: {error}", file=sys.stderr)
        sys.exit(1)
