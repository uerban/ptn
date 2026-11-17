#!/usr/bin/env python3
"""Measure how much one prepared GTFS feed differs from the one it replaces.

The result is a record for operators, never a gate: it does not decide whether
a feed is published. Rows are compared by their GTFS key and by column name, so
reordered columns or rows are not a change.
GTFS tables: https://gtfs.org/documentation/schedule/reference/#dataset-files
"""

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

KEYED = {"stops": "stop_id", "routes": "route_id", "trips": "trip_id"}
MODULUS = 1 << 128


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _rows(archive, name):
    """Yield (header, values) with the same strictness as feed preparation."""
    if archive.namelist().count(name) != 1:
        raise ValueError(f"expected one {name}")
    stream = io.TextIOWrapper(archive.open(name), encoding="utf-8-sig", newline="")
    reader = csv.reader(stream)
    header = next(reader, None)
    if not header or len(set(header)) != len(header):
        raise ValueError(f"invalid {name} header")
    for values in reader:
        if not values:
            continue
        if len(values) != len(header):
            raise ValueError(f"ragged {name}")
        yield header, values


def _header(archive, name):
    with archive.open(name) as raw:
        line = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="").readline()
    header = next(csv.reader([line]), None)
    if not header or len(set(header)) != len(header):
        raise ValueError(f"invalid {name} header")
    return header


def _row_digest(columns, positions, values):
    h = hashlib.blake2b(digest_size=16)
    for column, position in zip(columns, positions):
        h.update(column.encode())
        h.update(b"\x1f")
        h.update(values[position].encode())
        h.update(b"\x1e")
    return h.digest()


def _keyed(archive, name, key, columns):
    """Map key -> row digest over the given columns, in sorted column order."""
    result = {}
    positions = None
    for header, values in _rows(archive, name):
        if positions is None:
            if key not in header:
                raise ValueError(f"{name} lacks {key}")
            positions = [header.index(c) for c in columns]
            key_position = header.index(key)
        identity = values[key_position]
        if identity in result:
            raise ValueError(f"duplicate {key} in {name}")
        result[identity] = _row_digest(columns, positions, values)
    return result


def _trip_sums(archive, columns):
    """Per trip, an order-independent sum of stop-time row digests."""
    sums, count = {}, 0
    positions = None
    for header, values in _rows(archive, "stop_times.txt"):
        if positions is None:
            if "trip_id" not in header:
                raise ValueError("stop_times.txt lacks trip_id")
            positions = [header.index(c) for c in columns]
            trip_position = header.index("trip_id")
        trip = values[trip_position]
        value = int.from_bytes(_row_digest(columns, positions, values), "big")
        sums[trip] = (sums.get(trip, 0) + value) % MODULUS
        count += 1
    return sums, count


def _summary(previous, current):
    added = len(current.keys() - previous.keys())
    removed = len(previous.keys() - current.keys())
    changed = sum(1 for key, value in previous.items() if key in current and current[key] != value)
    return {
        "previous": len(previous),
        "current": len(current),
        "added": added,
        "removed": removed,
        "changed": changed,
        "changePercent": round((added + removed + changed) / max(len(previous), 1) * 100, 4),
    }


def _shared(previous_archive, current_archive, name):
    before, after = _header(previous_archive, name), _header(current_archive, name)
    return sorted(set(before) & set(after)), set(before) != set(after)


def _service_end(archive):
    """Last date with any scheduled service, ignoring whether trips use it."""
    last = ""
    names = archive.namelist()
    if "calendar.txt" in names:
        position = None
        for header, values in _rows(archive, "calendar.txt"):
            if position is None:
                position = header.index("end_date")
            last = max(last, values[position])
    if "calendar_dates.txt" in names:
        position = None
        for header, values in _rows(archive, "calendar_dates.txt"):
            if position is None:
                position = (header.index("date"), header.index("exception_type"))
            if values[position[1]] == "1":
                last = max(last, values[position[0]])
    if len(last) != 8 or not last.isdigit():
        return None
    return f"{last[:4]}-{last[4:6]}-{last[6:]}"


def _counts(archive):
    tables = {}
    for name, key in KEYED.items():
        tables[name] = {"current": len(_keyed(archive, name + ".txt", key, [key]))}
    sums, rows = _trip_sums(archive, ["trip_id"])
    tables["stop_times"] = {"current": len(sums), "currentRows": rows}
    return tables


def compare(previous, current):
    """Return the change record for `current` against `previous` (or no baseline)."""
    current = Path(current)
    try:
        current_sha = digest(current)
        with zipfile.ZipFile(current) as after:
            record = {
                "previousSha256": None,
                "sha256": current_sha,
                "bytes": {"previous": None, "current": current.stat().st_size},
                "serviceEnd": {"previous": None, "current": _service_end(after)},
                "changePercent": None,
            }
            if previous is None:
                record["tables"] = _counts(after)
                record["baseline"] = "none"
                return record
            previous = Path(previous)
            record["previousSha256"] = digest(previous)
            record["bytes"]["previous"] = previous.stat().st_size
            with zipfile.ZipFile(previous) as before:
                record["serviceEnd"]["previous"] = _service_end(before)
                if record["previousSha256"] == current_sha:
                    record["identical"] = True
                    record["changePercent"] = 0.0
                    record["tables"] = {}
                    return record
                tables = {}
                for name, key in KEYED.items():
                    file = name + ".txt"
                    columns, schema_changed = _shared(before, after, file)
                    tables[name] = _summary(
                        _keyed(before, file, key, columns), _keyed(after, file, key, columns)
                    )
                    if schema_changed:
                        tables[name]["schemaChanged"] = True
                columns, schema_changed = _shared(before, after, "stop_times.txt")
                old, old_rows = _trip_sums(before, columns)
                new, new_rows = _trip_sums(after, columns)
                tables["stop_times"] = {"previousRows": old_rows, "currentRows": new_rows, **_summary(old, new)}
                if schema_changed:
                    tables["stop_times"]["schemaChanged"] = True
                record["tables"] = tables
                record["changePercent"] = max(t["changePercent"] for t in tables.values())
                return record
    except (zipfile.BadZipFile, KeyError, UnicodeDecodeError, csv.Error) as error:
        raise ValueError(f"unreadable GTFS feed: {error}") from error


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("previous", type=Path)
    parser.add_argument("current", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(compare(args.previous, args.current), indent=2))
    except (ValueError, OSError) as error:
        print(f"feed change: {error}", file=sys.stderr)
        sys.exit(1)
