#!/usr/bin/env python3
"""Remember the feeds behind the published generation and record what changed.

`latest-validated.json` moves on every successful preparation, also when the
producer then fails or a pin holds publication. Change is therefore measured
against the bytes that were last actually published. The history is a record
for operators; it never blocks a refresh.
"""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil

from feed_change import compare

HISTORY_LINES = 1000


def _write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def _baseline(feeds_state):
    try:
        return json.loads((feeds_state / "last-published.json").read_text())["feeds"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def changes(feeds_state, prepared):
    """One change record per prepared feed against the last published feeds."""
    feeds_state = Path(feeds_state)
    baseline = _baseline(feeds_state)
    records = []
    for feed in prepared["feeds"]:
        source = feed["sourceId"]
        record = {
            "evaluatedAt": datetime.now(timezone.utc).isoformat(),
            "city": prepared.get("city"),
            "sourceId": source,
        }
        previous = feeds_state / "published" / f"{source}.zip"
        known = baseline.get(source, {}).get("sha256")
        try:
            record.update(compare(previous if known and previous.is_file() else None, feed["path"]))
            if record["previousSha256"] not in (None, known):
                # The retained copy is not the published one; do not report against it.
                record.update(compare(None, feed["path"]))
                record["baseline"] = "retained copy differs from the published record"
        except (ValueError, OSError) as error:
            record["error"] = str(error)
        records.append(record)
    return records


def record(feeds_state, prepared, records):
    """After a successful publication: retain the feeds and append real changes."""
    feeds_state = Path(feeds_state)
    directory = feeds_state / "published"
    directory.mkdir(parents=True, exist_ok=True)
    feeds = {}
    for feed in prepared["feeds"]:
        target = directory / f"{feed['sourceId']}.zip"
        temporary = target.with_name(target.name + ".tmp")
        shutil.copyfile(feed["path"], temporary)
        temporary.replace(target)
        feeds[feed["sourceId"]] = {"sha256": feed["sha256"], "path": str(target)}
    for stale in directory.glob("*.zip"):
        if stale.stem not in feeds:
            stale.unlink()
    _write_json(
        feeds_state / "last-published.json",
        {"schemaVersion": 1, "publishedAt": datetime.now(timezone.utc).isoformat(), "feeds": feeds},
    )
    fresh = [r for r in records if not r.get("identical")]
    if not fresh:
        return
    history = feeds_state / "change-history.jsonl"
    lines = history.read_text().splitlines() if history.exists() else []
    lines += [json.dumps(r, sort_keys=True) for r in fresh]
    temporary = history.with_name(history.name + ".tmp")
    temporary.write_text("\n".join(lines[-HISTORY_LINES:]) + "\n")
    temporary.replace(history)
