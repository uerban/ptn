#!/usr/bin/env python3
"""Expiring refresh pin: hold the serving feeds still for a bounded time.

A pin is an operator statement that the published data must not change, for
example while comparing a candidate with this host. It always expires, so a
forgotten pin cannot let a timetable run out. An absent file means unpinned;
an unreadable or malformed file means pinned, so damage never unfreezes feeds.
"""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path

DEFAULT_HOURS = 24
MAX_HOURS = 168


def read(path, now=None):
    """Return the active pin, or None when unpinned or expired."""
    now = now or datetime.now(timezone.utc)
    path = Path(path)
    try:
        text = path.read_text()
    except FileNotFoundError:
        return None
    except OSError as error:
        return {"reason": f"unreadable pin file: {error}", "malformed": True}
    try:
        pin = json.loads(text)
        expires = datetime.fromisoformat(pin["expiresAt"])
        if expires.tzinfo is None or not isinstance(pin["reason"], str) or not pin["reason"].strip():
            raise ValueError("incomplete pin")
    except (ValueError, KeyError, TypeError):
        return {"reason": "malformed pin file", "malformed": True}
    return pin if now < expires else None


def write(path, reason, hours=DEFAULT_HOURS, holder="operator", now=None):
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("a pin needs a reason")
    if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 0 < hours <= MAX_HOURS:
        raise ValueError(f"pin hours must be above 0 and at most {MAX_HOURS}")
    now = now or datetime.now(timezone.utc)
    pin = {
        "schemaVersion": 1,
        "reason": reason.strip(),
        "holder": holder,
        "setAt": now.isoformat(),
        "expiresAt": (now + timedelta(hours=hours)).isoformat(),
    }
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        json.dump(pin, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    return pin


def clear(path):
    Path(path).unlink(missing_ok=True)


def describe(pin):
    if pin is None:
        return "unpinned"
    if pin.get("malformed"):
        return f"pinned: {pin['reason']} (remove or rewrite the pin file)"
    return f"pinned until {pin['expiresAt']}: {pin['reason']}"
