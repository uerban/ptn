"""Native host adapter for signed transit selections; no generation builders."""
import fcntl
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


def refresh_delay(config):
    """Daily, staggered prebuilt updates; source-driven hosts keep their cadence."""
    import random

    prebuilt = config.get("transitMode", "source") == "prebuilt"
    interval = config.get("refreshIntervalSeconds", 86400 if prebuilt else 3600)
    if type(interval) is not int or interval < 60:
        raise ValueError("refreshIntervalSeconds must be an integer >= 60")
    return random.uniform(0.9, 1.1) * interval if prebuilt else interval


def run(command, config, state, binary_dir):
    transit = config.get("transitPack")
    if not isinstance(transit, dict):
        raise ValueError("prebuilt mode requires transitPack configuration")
    keys = transit.get("trustedKeys")
    if not isinstance(keys, list) or not keys or any(
        not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{64}", key)
        for key in keys
    ):
        raise ValueError("transitPack.trustedKeys requires lowercase hex public keys")
    geometry = transit.get("geometry", True)
    if type(geometry) is not bool:
        raise ValueError("transitPack.geometry must be a boolean")
    store = state / "prebuilt"
    runtime = state / "run"
    runtime.mkdir(parents=True, exist_ok=True)
    city = config["city"]  # Already validated by the public city descriptor.
    if command == "refresh":
        source = transit.get("source")
        if not isinstance(source, dict):
            raise ValueError("transitPack.source is required for refresh")
        if source.get("kind") == "https":
            url = source.get("url")
            if not isinstance(url, str):
                raise ValueError("transitPack.source.url must be an HTTPS URL")
            parsed = urlsplit(url)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                    or parsed.password or parsed.query or parsed.fragment):
                raise ValueError("transitPack.source.url must be a plain HTTPS URL")
            source_args = ["--source-url", url]
        elif source.get("kind") == "local":
            directory = source.get("directory")
            if not isinstance(directory, str) or not Path(directory).is_absolute():
                raise ValueError("transitPack.source.directory must be absolute")
            source_args = ["--source-directory", directory]
        else:
            raise ValueError("transitPack.source.kind must be https or local")
        args = [str(binary_dir / "pt-transit"), "--root", str(store), "--city", city]
        for key in keys:
            args.extend(["--trusted-key", key])
        args.extend(["sync", *source_args, "--from-discovery"])
        if not geometry:
            args.append("--without-geometry")
        for setting, flag in (("maxFileBytes", "--max-file-bytes"),
                              ("maxSelectedBytes", "--max-selected-bytes")):
            if setting in transit:
                value = transit[setting]
                if type(value) is not int or value <= 0:
                    raise ValueError(f"transitPack.{setting} must be a positive integer")
                args.extend([flag, str(value)])
        # Match the source-driven host lock; pt-transit also owns its store lock.
        with (state / "refresh.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            subprocess.run(args, check=True)
        return
    if command != "serve":
        raise ValueError("unsupported prebuilt host command")
    memory = config.get("memoryBudget", {})
    args = [str(binary_dir / "pt-serve"), f"--city-slug={city}",
            f"--city-tz-iana-default={config['timezone']}",
            f"--transit-store-root={store}", f"--data-root={runtime}",
            f"--pidfile-path={runtime / 'pt-serve.pid'}",
            f"--listen-addr={config.get('listenAddress', '127.0.0.1:9000')}",
            f"--metrics-listen-addr={config.get('auxAddress', '127.0.0.1:9001')}",
            f"--loopback-listen-addr={config.get('internalAddress', '127.0.0.1:9002')}",
            "--page-warm-mode=off"]
    if not isinstance(memory, dict):
        raise ValueError("memoryBudget must be an object")
    for setting, flag in (("maxRssBytes", "max-rss-bytes"),
                          ("processFixedOverheadBytes", "process-fixed-overhead-bytes"),
                          ("perWorkerOverheadBytes", "per-worker-overhead-bytes")):
        value = memory.get(setting)
        if type(value) is not int or value <= 0:
            raise ValueError(f"memoryBudget.{setting} must be a positive integer")
        args.append(f"--{flag}={value}")
    args.extend(f"--transit-trusted-key={key}" for key in keys)
    if not geometry:
        args.append("--without-geometry")
    if config.get("tripUpdatesURL"):
        args.append(f"--rt-trip-updates-urls={config['tripUpdatesURL']}")
    if config.get("serviceAlertsURL"):
        args.append(f"--rt-service-alerts-urls={config['serviceAlertsURL']}")
    os.execve(args[0], args, dict(os.environ))
