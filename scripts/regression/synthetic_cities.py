#!/usr/bin/env python3
"""Serve two synthetic GTFS cities through the real producer and pt-serve.

The city-switch and viewport-pan regression gates need two cities large enough
to show data-volume regressions, without private feeds or network downloads.
Each feed is generated from a fixed seed, published by `pt-producer republish`
(the same path as examples/native/host.py) and served by its own pt-serve.

    synthetic_cities.py --bin-dir target/release --work DIR --catalog OUT.json

Writes OUT.json once every server answers /ready, then keeps serving until
SIGTERM/SIGINT. The catalog lists each city's API origins for the browser test.
GTFS reference: https://gtfs.org/documentation/schedule/reference/
"""
import argparse
import csv
import io
import json
import math
import os
from pathlib import Path
import random
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile

# Sizes sit between the reference Vilnius and Krakow feeds used by the
# city-switch investigation (docs/diagnostics/city-switch-performance).
CITIES = (
    {"id": "synthetic-north", "name": "Synthetic North", "tz": "Europe/Vilnius",
     "center": (54.6872, 25.2797), "grid": 32, "routes": 60, "seed": 1},
    {"id": "synthetic-south", "name": "Synthetic South", "tz": "Europe/Warsaw",
     "center": (50.0647, 19.9450), "grid": 48, "routes": 120, "seed": 2},
)
STOP_SPACING_M = 260
SERVICE_START, SERVICE_END = "20260101", "20281231"


def offset(center, north_m, east_m):
    lat, lon = center
    return (lat + north_m / 111_320,
            lon + east_m / (111_320 * math.cos(math.radians(lat))))


def table(header, rows):
    text = io.StringIO()
    writer = csv.writer(text, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return text.getvalue()


def hms(seconds):
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"


def build_feed(city, path):
    rng = random.Random(city["seed"])
    n = city["grid"]
    half = (n - 1) / 2
    stops = {}
    for row in range(n):
        for col in range(n):
            lat, lon = offset(city["center"], (row - half) * STOP_SPACING_M, (col - half) * STOP_SPACING_M)
            stops[(row, col)] = (f"S{row}-{col}", f"{city['name']} {row}/{col}", f"{lat:.6f}", f"{lon:.6f}")
    routes, trips, stop_times = [], [], []
    for index in range(city["routes"]):
        # Straight, diagonal and dog-leg lines give overlapping corridors, so
        # stops carry several lines as in a real network.
        kind = index % 4
        line = rng.randrange(n)
        if kind == 0:
            path_cells = [(line, c) for c in range(n)]
        elif kind == 1:
            path_cells = [(r, line) for r in range(n)]
        elif kind == 2:
            path_cells = [(r, (r + line) % n) for r in range(n)]
        else:
            turn = rng.randrange(n // 4, 3 * n // 4)
            path_cells = [(line, c) for c in range(turn)] + [(r, turn) for r in range(line, n)]
        sequence = [stops[cell][0] for i, cell in enumerate(path_cells) if i == 0 or cell != path_cells[i - 1]]
        route_id = f"R{index}"
        tram = index % 5 == 0
        routes.append((route_id, "A", str(index + 1), f"Line {index + 1}", 0 if tram else 3,
                       "C0392B" if tram else "2471A3", "FFFFFF"))
        headway = rng.choice((300, 420, 600, 900))
        for direction, ordered in enumerate((sequence, sequence[::-1])):
            headsign = stops[path_cells[-1 if direction == 0 else 0]][1]
            # Round-the-clock service: the gate must find departures at any hour.
            for start in range(rng.randrange(headway), 24 * 3600, headway):
                trip_id = f"{route_id}-{direction}-{start}"
                trips.append((route_id, "DAILY", trip_id, headsign, direction))
                for sequence_index, stop_id in enumerate(ordered):
                    at = hms(start + sequence_index * 75)
                    stop_times.append((trip_id, at, at, stop_id, sequence_index + 1))
    files = {
        "agency.txt": table(("agency_id", "agency_name", "agency_url", "agency_timezone"),
                            [("A", f"{city['name']} Transit", "https://example.invalid", city["tz"])]),
        "stops.txt": table(("stop_id", "stop_name", "stop_lat", "stop_lon"), stops.values()),
        "routes.txt": table(("route_id", "agency_id", "route_short_name", "route_long_name",
                             "route_type", "route_color", "route_text_color"), routes),
        "calendar.txt": table(("service_id", "monday", "tuesday", "wednesday", "thursday", "friday",
                               "saturday", "sunday", "start_date", "end_date"),
                              [("DAILY", 1, 1, 1, 1, 1, 1, 1, SERVICE_START, SERVICE_END)]),
        "trips.txt": table(("route_id", "service_id", "trip_id", "trip_headsign", "direction_id"), trips),
        "stop_times.txt": table(("trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"), stop_times),
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in files.items():
            # Fixed timestamps keep the archive bytes reproducible.
            archive.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), text)
    return {"stops": len(stops), "routes": len(routes), "trips": len(trips), "stopTimes": len(stop_times)}


def free_ports(count):
    sockets = [socket.socket() for _ in range(count)]
    try:
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


def wait_ready(server, port, log):
    deadline = time.monotonic() + 120
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"pt-serve exited; inspect {log}")
        try:
            with opener.open(f"http://127.0.0.1:{port}/ready", timeout=5) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"pt-serve readiness timed out; inspect {log}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True, help="new directory for feeds, data roots and logs")
    parser.add_argument("--catalog", type=Path, required=True, help="written once all cities are ready")
    args = parser.parse_args()
    binaries = args.bin_dir.resolve()
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=False)
    servers, catalog = [], []
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("PT_SERVE_") and key != "PT_DATA_ROOT_ID"}

    def stop(*_):
        for server in servers:
            if server.poll() is None:
                server.terminate()
        for server in servers:
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for city in CITIES:
            root = work / city["id"]
            data, runtime = root / "transit", root / "run"
            data.mkdir(parents=True)
            runtime.mkdir()
            feed = root / "feed.zip"
            size = build_feed(city, feed)
            listen, metrics, loopback = free_ports(3)
            serve = [str(binaries / "pt-serve"), f"--city-slug={city['id']}",
                     f"--city-tz-iana-default={city['tz']}", f"--data-root={data}",
                     f"--pidfile-path={runtime / 'pt-serve.pid'}",
                     f"--listen-addr=127.0.0.1:{listen}", f"--metrics-listen-addr=127.0.0.1:{metrics}",
                     f"--loopback-listen-addr=127.0.0.1:{loopback}", "--max-rss-bytes=2147483648",
                     "--process-fixed-overhead-bytes=200000000", "--per-worker-overhead-bytes=50000000"]
            # An empty root makes the reader advertise its version before it
            # rejects the absent generation; the producer requires that file.
            subprocess.run(serve, capture_output=True, timeout=30, env=environment)
            if not (data / "pt-serve.version").is_file():
                raise RuntimeError(f"{city['id']}: reader bootstrap failed")
            started = time.monotonic()
            with (root / "producer.log").open("wb") as log:
                subprocess.run([str(binaries / "pt-producer"), "republish", "--data-root", str(data),
                                "--city", city["id"], "--city-tz-iana", city["tz"], "--from-cache", str(feed),
                                "--max-retained-generations", "1"],
                               check=True, stdout=log, stderr=subprocess.STDOUT, timeout=1800,
                               env={**environment, "PT_COLOR_BUILD": "rust", "PT_TILE_BUILD": "rust"})
            publish_seconds = round(time.monotonic() - started, 1)
            log_path = root / "serve.log"
            server = subprocess.Popen(serve, stdout=log_path.open("wb"), stderr=subprocess.STDOUT, env=environment)
            servers.append(server)
            wait_ready(server, metrics, log_path)
            south, west = offset(city["center"], -(city["grid"] / 2 + 2) * STOP_SPACING_M,
                                 -(city["grid"] / 2 + 2) * STOP_SPACING_M)
            north, east = offset(city["center"], (city["grid"] / 2 + 2) * STOP_SPACING_M,
                                 (city["grid"] / 2 + 2) * STOP_SPACING_M)
            catalog.append({"id": city["id"], "name": city["name"], "tz": city["tz"],
                            "center": {"lat": city["center"][0], "lon": city["center"][1]},
                            "bbox": {"minLat": south, "minLon": west, "maxLat": north, "maxLon": east},
                            # Like examples/native/Caddyfile: health/ready/version
                            # live on the auxiliary listener, the rest on main.
                            "apiOrigin": f"http://127.0.0.1:{listen}",
                            "auxOrigin": f"http://127.0.0.1:{metrics}",
                            "feed": {**size, "publishSeconds": publish_seconds}})
            print(f"{city['id']}: {size} published in {publish_seconds}s, serving on {listen}", flush=True)
        args.catalog.write_text(json.dumps({"schemaVersion": 2, "cities": catalog}, indent=2) + "\n")
        print(f"catalog: {args.catalog}", flush=True)
        while all(server.poll() is None for server in servers):
            time.sleep(1)
        raise RuntimeError("a pt-serve process exited")
    except BaseException:
        if not isinstance(sys.exc_info()[1], SystemExit):
            for server in servers:
                if server.poll() is None:
                    server.terminate()
        raise


if __name__ == "__main__":
    main()
