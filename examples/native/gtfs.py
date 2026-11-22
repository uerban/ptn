#!/usr/bin/env python3
"""Source-driven GTFS preparation shipped with native and Docker PTN releases.

Calendar semantics: https://gtfs.org/documentation/schedule/reference/#calendar_datestxt
Recipes are trusted Python code, pinned by archive SHA-256, never floating branches.
This command prepares candidates; only pt-producer publishes serving generations.
"""

import argparse
import csv
from datetime import date, datetime, timedelta, timezone
import fcntl
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from zoneinfo import ZoneInfo

VALIDATOR_SHA = "19293ddd9b6f954f216d4f12054bd8a3232921751c4484339e339764a91000e2"
VALIDATOR_URL = "https://github.com/MobilityData/gtfs-validator/releases/download/v8.0.1/gtfs-validator-8.0.1-cli.jar"
LIMIT = 256 * 1024 * 1024
EXPANDED_LIMIT = 2 * 1024 * 1024 * 1024
SECRET_FORMAT = re.compile(r"[A-Za-z0-9._~-]{8,256}")
ENVIRONMENT_NAME = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
# Environment variables holding source credentials; removed from every child.
SECRET_ENVIRONMENT = set()


def child_environment():
    hidden = SECRET_ENVIRONMENT | {"PT_FEEDS_TOKEN"}
    return {k: v for k, v in os.environ.items() if k not in hidden}


class SourceError(OSError):
    """A source retrieval failure whose message never contains a URL or secret.

    `transport` marks failures that may fall back to another candidate.
    """

    def __init__(self, message, *, transport=False, status=None, outcome="error"):
        super().__init__(message)
        self.transport, self.status, self.outcome = transport, status, outcome


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


class Redirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, credentialed=False):
        super().__init__()
        self.credentialed = credentialed

    def redirect_request(self, request, *args, **kwargs):
        redirected = super().redirect_request(request, *args, **kwargs)
        if redirected:
            require(
                urllib.parse.urlsplit(redirected.full_url).scheme == "https",
                "HTTPS downgrade redirect refused",
            )
            if (
                urllib.parse.urlsplit(request.full_url).netloc
                != urllib.parse.urlsplit(redirected.full_url).netloc
            ):
                if self.credentialed:
                    raise SourceError(
                        "credentialed cross-host redirect refused",
                        transport=True,
                        outcome="redirect",
                    )
                redirected.remove_header("Authorization")
        return redirected


TRANSPORT_STATUS = {401, 403, 404, 429}


# Certificate and protocol failures stop an origin; a dropped TLS stream does not.
TLS_HARD = (ssl.SSLCertVerificationError, ssl.CertificateError)


def classify(error):
    """Return (outcome, HTTP status, may fall back). Never inspects URLs."""
    if isinstance(error, SourceError):
        return error.outcome, error.status, error.transport
    if isinstance(error, urllib.error.HTTPError):
        return (
            "http",
            error.code,
            error.code >= 500 or error.code in TRANSPORT_STATUS,
        )
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        if isinstance(reason, TLS_HARD):
            return "tls", None, False
        if isinstance(reason, ssl.SSLError):
            return "transport", None, True
        return "connect", None, True
    if isinstance(error, TLS_HARD):
        return "tls", None, False
    if isinstance(error, ssl.SSLError):
        # EOF, reset or zero-return mid-handshake or mid-body: a dropped connection.
        return "transport", None, True
    if isinstance(error, (TimeoutError, http.client.HTTPException, ConnectionError)):
        return "transport", None, True
    if isinstance(error, ValueError):
        text = str(error)
        if "truncated" in text or "exceeds 256 MiB" in text:
            return "transport", None, True
        return "invalid", None, False
    if isinstance(error, OSError):
        return "transport", None, True
    return "error", None, False


def fetch(url, directory, *, token=None, allow_http=False, query_secret=None):
    """Content-addressed raw cache; conditional hits still verify retained bytes.

    `query_secret` is an optional (parameter, value) pair added to the request
    only: the cache key, metadata and every error message stay free of it.
    """
    parsed = urllib.parse.urlsplit(url)
    require(
        parsed.scheme == "https" or allow_http and parsed.scheme == "http",
        "source must use HTTPS (HTTP requires explicit source opt-in)",
    )
    require(
        parsed.hostname and not parsed.username and not parsed.password,
        "credentials in URLs are not supported",
    )
    if query_secret is not None:
        name, value = query_secret
        require(
            parsed.scheme == "https"
            and re.fullmatch("[A-Za-z0-9_-]{1,64}", name)
            and isinstance(value, str)
            and SECRET_FORMAT.fullmatch(value),
            "invalid source credential",
        )
        require(
            name not in urllib.parse.parse_qs(parsed.query, keep_blank_values=True),
            "source URL already sets the credential parameter",
        )
    directory.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()
    metadata = directory / (key + ".json")
    previous = json.loads(metadata.read_text()) if metadata.exists() else {}
    cached_hash = previous.get("sha256", "")
    cached = (
        directory / cached_hash if re.fullmatch("[a-f0-9]{64}", cached_hash) else None
    )
    valid = cached is not None and cached.is_file() and digest(cached) == cached_hash
    headers = {"User-Agent": "PTN-GTFS/1", "Accept-Encoding": "identity"}
    if valid:
        for name, field in (
            ("If-None-Match", "etag"),
            ("If-Modified-Since", "lastModified"),
        ):
            if previous.get(field):
                headers[name] = previous[field]
    if token:
        require(
            parsed.hostname == "api.github.com",
            "recipe token is restricted to api.github.com",
        )
        headers["Authorization"] = "Bearer " + token
    checked = datetime.now(timezone.utc).isoformat()
    if query_secret is None:
        return _fetch(
            url,
            url,
            directory,
            metadata,
            previous,
            cached,
            valid,
            headers,
            checked,
            token,
            False,
        )
    request_url = urllib.parse.urlunsplit(
        parsed._replace(
            query="&".join(
                part
                for part in (parsed.query, urllib.parse.urlencode([query_secret]))
                if part
            )
        )
    )
    try:
        return _fetch(
            url,
            request_url,
            directory,
            metadata,
            previous,
            cached,
            valid,
            headers,
            checked,
            token,
            True,
        )
    except Exception as error:  # noqa: BLE001 - re-raised without its context
        outcome, status, transport = classify(error)
        message = f"credentialed request failed: {type(error).__name__}" + (
            f" HTTP {status}" if status else ""
        )
    raise SourceError(message, transport=transport, status=status, outcome=outcome)


def _fetch(
    url,
    request_url,
    directory,
    metadata,
    previous,
    cached,
    valid,
    headers,
    checked,
    token,
    credentialed,
):
    opener = urllib.request.build_opener(Redirect(credentialed))
    try:
        response = opener.open(
            urllib.request.Request(request_url, headers=headers), timeout=60
        )
    except urllib.error.HTTPError as error:
        if error.code != 304:
            raise
        error.close()
        require(valid, "HTTP304 without verified cached input")
        previous.update(checkedAt=checked, httpStatus=304)
        write_json(metadata, previous)
        return cached, previous
    temporary = None
    try:
        with (
            response,
            tempfile.NamedTemporaryFile(dir=directory, delete=False) as output,
        ):
            require(response.status == 200, "unexpected download HTTP status")
            temporary = Path(output.name)
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                require(count <= LIMIT, "download exceeds 256 MiB limit")
                output.write(chunk)
            length = response.headers.get("Content-Length")
            require(not length or int(length) == count, "truncated HTTP response")
            output.flush()
            os.fsync(output.fileno())
        sha = digest(temporary)
        cached = directory / sha
        temporary.replace(cached)
        record = {
            "url": url,
            "resolvedURL": urllib.parse.urlunsplit(
                urllib.parse.urlsplit(response.geturl())._replace(query="", fragment="")
            )
            if token or credentialed
            else response.geturl(),
            "sha256": sha,
            "bytes": count,
            "downloadedAt": checked,
            "checkedAt": checked,
            "httpStatus": 200,
            "etag": response.headers.get("ETag"),
            "lastModified": response.headers.get("Last-Modified"),
        }
        write_json(metadata, record)
        return cached, record
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def check_zip(path):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        require(
            len(entries) <= 2000 and len({e.filename for e in entries}) == len(entries),
            "duplicate/excessive GTFS ZIP members",
        )
        require(
            sum(e.file_size for e in entries) <= EXPANDED_LIMIT,
            "expanded GTFS exceeds 2 GiB",
        )
        require(
            all(
                not e.is_dir()
                and "/" not in e.filename
                and "\\" not in e.filename
                and e.filename not in {".", ".."}
                and (e.external_attr >> 16) & 0o170000 != 0o120000
                for e in entries
            ),
            "unsafe GTFS ZIP member",
        )
        require(archive.testzip() is None, "corrupt GTFS ZIP")
        for name in (
            "agency.txt",
            "stops.txt",
            "routes.txt",
            "trips.txt",
            "stop_times.txt",
        ):
            require(name in archive.namelist(), f"missing root {name}")


def rows(archive, name):
    reader = csv.DictReader(
        io.TextIOWrapper(archive.open(name), encoding="utf-8-sig", newline="")
    )
    require(
        reader.fieldnames and len(reader.fieldnames) == len(set(reader.fieldnames)),
        f"invalid {name} header",
    )
    for row in reader:
        require(None not in row and None not in row.values(), f"ragged {name}")
        yield row


def coverage(path, tz):
    """Evaluate every required component for the next seven local service dates."""
    today = datetime.now(ZoneInfo(tz)).date()
    days = [today + timedelta(days=i) for i in range(7)]
    with zipfile.ZipFile(path) as archive:
        used = {r["service_id"] for r in rows(archive, "trips.txt")}
        active = {day: set() for day in days}
        if "calendar.txt" in archive.namelist():
            for row in rows(archive, "calendar.txt"):
                for day in days:
                    weekday = (
                        "monday",
                        "tuesday",
                        "wednesday",
                        "thursday",
                        "friday",
                        "saturday",
                        "sunday",
                    )[day.weekday()]
                    if (
                        row["start_date"] <= day.strftime("%Y%m%d") <= row["end_date"]
                        and row[weekday] == "1"
                    ):
                        active[day].add(row["service_id"])
        if "calendar_dates.txt" in archive.namelist():
            for row in rows(archive, "calendar_dates.txt"):
                for day in days:
                    if row["date"] == day.strftime("%Y%m%d"):
                        if row["exception_type"] == "1":
                            active[day].add(row["service_id"])
                        elif row["exception_type"] == "2":
                            active[day].discard(row["service_id"])
        return {
            day.isoformat(): bool(services & used) for day, services in active.items()
        }


def namespace_feed(source, output, source_id):
    """Scope IDs before the producer's keep-first union; leave times/order intact.

    Supported tables are explicit: unknown references require review, never a
    guessed partial rewrite. GTFS reference/#dataset-files and /#field-types.
    """
    tables = {
        "agency.txt",
        "stops.txt",
        "routes.txt",
        "trips.txt",
        "stop_times.txt",
        "calendar.txt",
        "calendar_dates.txt",
        "shapes.txt",
        "frequencies.txt",
        "transfers.txt",
        "feed_info.txt",
        "attributions.txt",
        "fare_attributes.txt",
        "fare_rules.txt",
        "blocks.txt",
        "networks.txt",
        "route_networks.txt",
    }
    fields = {
        "agency_id",
        "stop_id",
        "parent_station",
        "route_id",
        "network_id",
        "trip_id",
        "service_id",
        "shape_id",
        "block_id",
        "zone_id",
        "fare_id",
        "origin_id",
        "destination_id",
        "contains_id",
        "attribution_id",
        "from_stop_id",
        "to_stop_id",
        "from_route_id",
        "to_route_id",
        "from_trip_id",
        "to_trip_id",
    }
    with (
        zipfile.ZipFile(source) as incoming,
        zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as outgoing,
    ):
        require(
            set(incoming.namelist()) <= tables,
            "unsupported table in multi-feed namespace rewrite; review required",
        )
        for name in incoming.namelist():
            reader = csv.DictReader(
                io.TextIOWrapper(incoming.open(name), encoding="utf-8-sig", newline="")
            )
            require(
                reader.fieldnames
                and len(reader.fieldnames) == len(set(reader.fieldnames)),
                "invalid namespace header",
            )
            # Reject new ID references that this rewrite does not understand.
            require(
                not {
                    f
                    for f in reader.fieldnames
                    if f.endswith("_id") and f not in fields and f != "direction_id"
                },
                "unknown ID field in multi-feed namespace rewrite",
            )
            with outgoing.open(name, "w", force_zip64=True) as binary:
                text = io.TextIOWrapper(binary, encoding="utf-8", newline="")
                writer = csv.DictWriter(
                    text, fieldnames=reader.fieldnames, lineterminator="\n"
                )
                writer.writeheader()
                for row in reader:
                    require(
                        None not in row and None not in row.values(),
                        "ragged namespace input",
                    )
                    writer.writerow(
                        {
                            field: source_id + ":" + value
                            if field in fields and value
                            else value
                            for field, value in row.items()
                        }
                    )
                text.flush()
                text.detach()


def validate(path, output, jar):
    require(digest(jar) == VALIDATOR_SHA, "wrong GTFS validator checksum")
    subprocess.run(
        [
            "java",
            "-Xmx4g",
            "-jar",
            str(jar),
            "-i",
            str(path),
            "-o",
            str(output),
            "-t",
            "2",
        ],
        check=True,
        timeout=1800,
        env=child_environment(),
    )
    report = json.loads((output / "report.json").read_text())
    system = json.loads((output / "system_errors.json").read_text())
    require(
        isinstance(system.get("notices"), list) and not system["notices"],
        "GTFS validator system errors",
    )
    require(isinstance(report.get("notices"), list), "missing GTFS validator notices")
    require(
        all(
            n.get("severity") in {"INFO", "WARNING", "ERROR"} for n in report["notices"]
        ),
        "unknown validator severity",
    )
    return [
        {"code": n["code"], "totalNotices": n["totalNotices"]}
        for n in report["notices"]
        if n["severity"] == "ERROR"
    ]


def unpack_recipe(archive, destination):
    """GitHub source tarball: one root, regular files only; no extractall."""
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        require(
            len(members) <= 5000 and sum(m.size for m in members) <= 64 * 1024 * 1024,
            "recipe archive too large",
        )
        roots, seen = set(), set()
        for member in members:
            parts = PurePosixPath(member.name).parts
            require(
                parts
                and not member.name.startswith("/")
                and ".." not in parts
                and "\\" not in member.name,
                "unsafe recipe member path",
            )
            roots.add(parts[0])
            require(
                len(roots) == 1 and member.name not in seen,
                "duplicate members or multiple recipe roots",
            )
            seen.add(member.name)
            require(member.isdir() or member.isfile(), "recipe links/devices refused")
            if len(parts) == 1:
                require(member.isdir(), "missing recipe root directory")
                continue
            target = destination.joinpath(*parts[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with (
                    source.extractfile(member) as incoming,
                    target.open("xb") as output,
                ):
                    shutil.copyfileobj(incoming, output)


def recipe(config, state, attempt):
    specification = config["gtfsRecipe"]
    expected = specification["sha256"]
    require(
        re.fullmatch("[a-f0-9]{64}", expected), "recipe archive needs exact SHA-256"
    )
    if "archive" in specification:
        archive = Path(specification["archive"]).resolve()
    else:
        archive = state / "recipe-downloads" / expected
        if not archive.is_file() or digest(archive) != expected:
            archive, _ = fetch(
                specification["url"],
                state / "recipe-downloads",
                token=os.environ.get("PT_FEEDS_TOKEN"),
            )
    require(digest(archive) == expected, "recipe archive checksum mismatch")
    root = attempt / "recipe"
    unpack_recipe(archive, root)
    name = specification["name"]
    require(re.fullmatch("[a-z0-9_-]+", name), "invalid recipe name")
    definition = json.loads((root / "recipes" / (name + ".json")).read_text())
    require(definition.get("schemaVersion") in {1, 2}, "unsupported recipe schema")
    if definition["schemaVersion"] == 2:
        for source in definition.get("sources", []):
            check_source(source)
            if "auth" in source:
                SECRET_ENVIRONMENT.add(source["auth"]["env"])
    else:
        require(
            not any(
                (V2_SOURCE_KEYS - V1_SOURCE_KEYS) & set(s)
                for s in definition.get("sources", [])
            ),
            "mirrors, credentials, freshness and identity need recipe schemaVersion 2",
        )
    require(
        not definition.get("blockedReason"),
        definition.get("blockedReason", "blocked recipe"),
    )
    for variable in definition.get("requiredEnvironment", []):
        require(os.environ.get(variable), f"recipe requires {variable}")
    return definition, root, {"archiveSha256": expected, "name": name}


def source_url(source, state, directory):
    if "discovery" not in source:
        return source["url"]
    specification = source["discovery"]
    require(specification["kind"] == "riga-ckan-monthly-v1", "unknown source discovery")
    metadata, retrieval = fetch(specification["url"], state / "discovery")
    shutil.copyfile(metadata, directory / "discovery.json")
    write_json(directory / "discovery-retrieval.json", retrieval)
    document = json.loads(metadata.read_text())
    require(document.get("success") is True, "CKAN discovery failed")
    candidates = []
    for resource in document["result"]["resources"]:
        match = re.fullmatch(
            r"marsrutusaraksti(0[1-9]|1[0-2])_(20[0-9]{2})\.zip",
            resource.get("name", ""),
            re.IGNORECASE,
        )
        if match:
            url = resource["url"]
            require(
                urllib.parse.urlsplit(url).scheme == "https"
                and urllib.parse.urlsplit(url).hostname == "data.gov.lv",
                "unexpected Riga resource host",
            )
            candidates.append(((int(match[2]), int(match[1])), url))
    require(candidates, "no monthly Riga schedules in CKAN")
    latest = max(period for period, _ in candidates)
    selected = {url for period, url in candidates if period == latest}
    require(len(selected) == 1, "ambiguous latest Riga resource")
    return selected.pop()


V1_SOURCE_KEYS = {
    "id",
    "url",
    "discovery",
    "allowHTTP",
    "alwaysPrepare",
    "attribution",
    "policyStatus",
    "policyURL",
    "steps",
    "verifyCompaction",
}
V2_SOURCE_KEYS = V1_SOURCE_KEYS | {
    "mirror",
    "prefer",
    "auth",
    "budget",
    "freshness",
    "identity",
}


RESERVED_ENVIRONMENT = {
    "PT_FEEDS_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "HOME",
    "PATH",
    "SSH_AUTH_SOCK",
}


def check_source(source):
    """Schema 2 source shape: one origin `url` or `discovery`, optional mirror."""
    unknown = set(source) - V2_SOURCE_KEYS
    require(not unknown, f"unknown source keys: {sorted(unknown)}")
    require(
        ("url" in source) != ("discovery" in source),
        "source needs exactly one of url or discovery",
    )
    if "discovery" in source:
        require(
            not set(source)
            & {"mirror", "prefer", "auth", "budget", "freshness", "identity"},
            "discovery sources take no mirror, credentials or freshness",
        )
        return
    if "mirror" in source:
        mirror = source["mirror"]
        require(
            isinstance(mirror, dict)
            and set(mirror) == {"operator", "url"}
            and isinstance(mirror["operator"], str)
            and mirror["operator"].strip()
            and isinstance(mirror["url"], str),
            "mirror needs exactly operator and url",
        )
        require(
            urllib.parse.urlsplit(mirror["url"]).scheme == "https",
            "mirror must use HTTPS",
        )
        require(
            mirror["url"] != source["url"], "mirror must differ from the origin url"
        )
        require("identity" in source, "a source with a mirror needs identity")
    require(
        source.get("prefer", "origin") in {"origin", "mirror"},
        "prefer must be origin or mirror",
    )
    require("prefer" not in source or "mirror" in source, "prefer needs a mirror")
    if "auth" in source:
        auth = source["auth"]
        require(
            isinstance(auth, dict)
            and set(auth) == {"queryParam", "env"}
            and re.fullmatch("[A-Za-z0-9_-]{1,64}", auth["queryParam"])
            and ENVIRONMENT_NAME.fullmatch(auth["env"]),
            "auth needs queryParam and an upper-case env name",
        )
        require(
            auth["env"] not in RESERVED_ENVIRONMENT
            and not auth["env"].startswith(("PT_FEEDS_", "PTN_")),
            "auth env names a runtime variable",
        )
        require(
            auth["queryParam"]
            not in urllib.parse.parse_qs(
                urllib.parse.urlsplit(source["url"]).query, keep_blank_values=True
            ),
            "source URL already sets the credential parameter",
        )
        require(not source.get("allowHTTP"), "credentials require HTTPS")
    if "budget" in source:
        budget = source["budget"]
        require(
            isinstance(budget, dict)
            and set(budget) == {"requests", "days"}
            and all(type(budget[k]) is int and budget[k] > 0 for k in budget),
            "budget needs positive integer requests and days",
        )
        require("auth" in source, "budget applies to credentialed origins")
    if "freshness" in source:
        freshness = source["freshness"]
        require(
            isinstance(freshness, dict)
            and set(freshness) == {"signal", "format", "maxAgeDays"}
            and freshness["signal"] == "feed_info.feed_version"
            and isinstance(freshness["format"], str)
            and type(freshness["maxAgeDays"]) is int
            and freshness["maxAgeDays"] >= 0,
            "freshness needs signal feed_info.feed_version, format and maxAgeDays",
        )
    if "identity" in source:
        identity = source["identity"]
        require(
            isinstance(identity, dict)
            and set(identity) <= {"feedInfo", "agencyNames", "agencyCount"}
            and (identity.get("feedInfo") or identity.get("agencyNames")),
            "identity needs feedInfo or agencyNames",
        )
        require(
            isinstance(identity.get("feedInfo", {}), dict)
            and isinstance(identity.get("agencyNames", []), list)
            and (
                "agencyCount" not in identity
                or type(identity["agencyCount"]) is int
                and identity["agencyCount"] > 0
            ),
            "invalid identity",
        )
        require(
            all(
                isinstance(v, str) and v
                for v in [
                    *identity.get("feedInfo", {}).values(),
                    *identity.get("agencyNames", []),
                ]
            ),
            "identity values must be non-empty strings",
        )


def table(path, name):
    with zipfile.ZipFile(path) as archive:
        if name not in archive.namelist():
            return None
        return list(rows(archive, name))


def identity_problem(path, identity):
    info = (table(path, "feed_info.txt") or [{}])[0]
    for field, expected in identity.get("feedInfo", {}).items():
        if info.get(field) != expected:
            return f"feed_info.{field} differs"
    agencies = [r.get("agency_name") for r in table(path, "agency.txt") or []]
    missing = set(identity.get("agencyNames", [])) - set(agencies)
    if missing:
        return "expected agency missing"
    if "agencyCount" in identity and len(agencies) != identity["agencyCount"]:
        return f"agency count {len(agencies)} != {identity['agencyCount']}"
    return None


def freshness_of(path, specification, today):
    """Date-based freshness from feed_info.feed_version; None when unknown."""
    try:
        value = (table(path, "feed_info.txt") or [{}])[0].get("feed_version") or ""
        published = datetime.strptime(value, specification["format"]).date()
    except (ValueError, KeyError, csv.Error, zipfile.BadZipFile):
        return None
    if published > today + timedelta(days=1):
        return None
    age = max(0, (today - published).days)
    return {
        "value": published.isoformat(),
        "ageDays": age,
        "stale": age > specification["maxAgeDays"],
    }


def budget_directory(state):
    configured = os.environ.get("PT_FEEDS_BUDGET_DIR")
    return Path(configured) if configured else state / "budget"


LEDGER_RETENTION_DAYS = 400


def spend_budget(directory, name, budget, now=None):
    """Count one origin request before it is sent; False when the window is spent.

    One append-only ledger per credential, shared by every source and city
    that uses it. Failures, timeouts and 304 responses count too.
    """
    now = now or datetime.now(timezone.utc)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    ledger = directory / (name + ".ledger")
    with (directory / (name + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        since = now - timedelta(days=budget["days"])
        # Keep history for the longest window any source may use, so a source
        # with a short window never erases what a longer one counts.
        keep = now - timedelta(days=max(LEDGER_RETENTION_DAYS, budget["days"]))
        entries = []
        if ledger.exists():
            for line in ledger.read_text().splitlines():
                try:
                    stamp = datetime.fromisoformat(line.strip())
                except ValueError:
                    continue
                if stamp > keep:
                    entries.append(stamp)
        if sum(stamp > since for stamp in entries) >= budget["requests"]:
            return False
        entries.append(now)
        temporary = ledger.with_name(ledger.name + ".tmp")
        with temporary.open("w") as stream:
            stream.write("".join(e.isoformat() + "\n" for e in entries))
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(ledger)
        return True


def freshness_floor(config, state, source_id):
    """Last accepted freshness date: the newer of host config and validated result.

    Read regardless of recipe or runtime identity so upgrades keep the floor.
    A configured floor can raise the floor but never lower it.
    """
    values = []
    configured = config.get("freshnessFloors", {})
    require(isinstance(configured, dict), "freshnessFloors must be an object")
    if source_id in configured:
        try:
            values.append(date.fromisoformat(configured[source_id]))
        except (TypeError, ValueError):
            raise ValueError(
                f"freshnessFloors.{source_id} must be YYYY-MM-DD"
            ) from None
    pointer = state / "latest-validated.json"
    try:
        result = json.loads(Path(json.loads(pointer.read_text())["result"]).read_text())
        for record in result.get("feeds", []):
            if record.get("sourceId") == source_id:
                value = ((record.get("retrieval") or {}).get("freshness") or {}).get(
                    "value"
                )
                if value:
                    values.append(date.fromisoformat(value))
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return max(values).isoformat() if values else None


def acquire(source, state, *, today, floor, credentials=()):
    """Fetch a source from its origin and optional mirror; return (raw, retrieval)."""
    mirror = source.get("mirror")
    order = [("origin", source["url"])]
    if mirror:
        order.append(("mirror", mirror["url"]))
        if source.get("prefer") == "mirror":
            order.reverse()
    specification = source.get("freshness")
    attempts, warnings, stale = [], [], []

    regressed = []

    def accept(kind, raw, retrieval, fresh):
        if fresh and floor and kind == "origin" and fresh["value"] < floor:
            warnings.append(
                f"origin data {fresh['value']} is older than accepted {floor}"
            )
        if kind == "mirror" and source.get("prefer", "origin") == "origin":
            warnings.append("mirror used for an origin-first source")
        record = {
            **retrieval,
            "candidate": {
                "kind": kind,
                **({"operator": mirror["operator"]} if kind == "mirror" else {}),
            },
            "attempts": attempts,
        }
        if specification:
            record["freshness"] = {
                **(fresh or {"value": None}),
                "measuredOn": today.isoformat(),
            }
        if floor:
            record["floor"] = floor
        if warnings:
            record["warnings"] = warnings
        return raw, record

    for kind, url in order:
        attempt = {"candidate": kind}
        attempts.append(attempt)
        secret = None
        if kind == "origin" and "auth" in source:
            if source["auth"]["env"] not in credentials:
                attempt["outcome"] = "no-credentials"
                warnings.append("origin credential not allowed by host configuration")
                continue
            value = os.environ.get(source["auth"]["env"], "")
            if not SECRET_FORMAT.fullmatch(value):
                attempt["outcome"] = "no-credentials"
                warnings.append("origin credential missing or malformed")
                continue
            secret = (source["auth"]["queryParam"], value)
            if "budget" in source and not spend_budget(
                budget_directory(state), source["auth"]["env"], source["budget"]
            ):
                attempt["outcome"] = "no-budget"
                warnings.append("origin request budget spent")
                continue
        try:
            raw, retrieval = fetch(
                url,
                state / "raw",
                allow_http=kind == "origin" and source.get("allowHTTP", False),
                query_secret=secret,
            )
        except Exception as error:  # noqa: BLE001 - classified below
            outcome, status, transport = classify(error)
            attempt.update(
                outcome=outcome,
                **({"httpStatus": status} if status else {}),
                error=type(error).__name__,
            )
            if kind == "origin" and status in {401, 403} and secret:
                warnings.append(f"origin refused credential (HTTP {status})")
            if not transport and kind == "origin":
                raise SourceError(
                    f"{source['id']}: {kind} {outcome} failure ({type(error).__name__})",
                    outcome=outcome,
                ) from None
            if not transport:
                warnings.append(f"mirror {outcome} failure")
            continue
        attempt["httpStatus"] = retrieval.get("httpStatus")
        try:
            check_zip(raw)
        except Exception:  # noqa: BLE001 - any unreadable archive is "not a GTFS ZIP"
            attempt["outcome"] = "not-zip"
            if kind == "origin":
                warnings.append("origin returned something other than a GTFS ZIP")
            continue
        try:
            problem = (
                identity_problem(raw, source["identity"])
                if "identity" in source
                else None
            )
            fresh = freshness_of(raw, specification, today) if specification else None
        except (ValueError, KeyError, csv.Error, zipfile.BadZipFile) as error:
            attempt["outcome"] = "unreadable"
            if kind == "origin":
                raise SourceError(
                    f"{source['id']}: origin feed_info/agency unreadable "
                    f"({type(error).__name__})",
                    outcome="unreadable",
                ) from None
            continue
        if problem:
            attempt["outcome"] = "identity"
            if kind == "origin":
                raise SourceError(f"{source['id']}: origin identity changed: {problem}")
            continue
        if fresh and floor and kind == "mirror" and fresh["value"] < floor:
            # Never let a mirror move served data backwards; try the next one.
            attempt["outcome"] = "regressed"
            regressed.append(fresh["value"])
            continue
        if specification:
            if fresh is None:
                if kind == "mirror":
                    attempt["outcome"] = "freshness-unknown"
                    continue
                warnings.append("origin freshness unknown")
            elif fresh["stale"]:
                attempt["outcome"] = "stale"
                stale.append((fresh["value"], kind, raw, retrieval, fresh))
                continue
        attempt["outcome"] = "accepted"
        return accept(kind, raw, retrieval, fresh)
    if not stale and regressed:
        raise SourceError(
            f"{source['id']}: mirror data {max(regressed)} is older than "
            f"accepted {floor}",
            outcome="regressed",
        )
    if stale:
        _, kind, raw, retrieval, fresh = max(stale, key=lambda item: item[0])
        warnings.append(f"no fresh candidate; using {kind} data from {fresh['value']}")
        next(a for a in attempts if a["candidate"] == kind)["outcome"] = (
            "accepted-stale"
        )
        return accept(kind, raw, retrieval, fresh)
    raise SourceError(
        f"{source['id']}: no usable candidate ("
        + ", ".join(f"{a['candidate']} {a.get('outcome')}" for a in attempts)
        + ")"
    )


def reusable_source(state, identity, source_id, raw_sha):
    pointer = state / "latest-validated.json"
    if not pointer.exists():
        return None
    previous = json.loads(pointer.read_text())
    result_path = Path(previous["result"])
    if not result_path.is_file() or digest(result_path) != previous["sha256"]:
        return None
    result = json.loads(result_path.read_text())
    if (
        not result.get("passed")
        or result.get("recipe") != identity
        or result.get("runtimeSha256") != digest(__file__)
    ):
        return None
    for record in result["feeds"]:
        if record["sourceId"] == source_id and record["original"]["sha256"] == raw_sha:
            directory = Path(record["path"]).parent
            evidence = record.get("evidenceSha256", {})
            if evidence and all(
                not Path(name).is_absolute()
                and ".." not in Path(name).parts
                and (directory / name).is_file()
                and digest(directory / name) == sha
                for name, sha in evidence.items()
            ):
                return directory
    return None


def prune_attempts(state, keep):
    """Retain three successful and three failed attempts by default, plus cache.

    Only directories marked by this tool are removed. Serving generations live
    elsewhere and have their own producer retention policy.
    """
    pointer = state / "latest-validated.json"
    protected = (
        Path(json.loads(pointer.read_text())["result"]).parent
        if pointer.exists()
        else None
    )
    for marker in ("result.json", "failure.json"):
        candidates = sorted(
            (
                p
                for p in (state / "attempts").iterdir()
                if p.is_dir()
                and not p.is_symlink()
                and (p / "managed-by-ptn").is_file()
                and (p / marker).is_file()
            ),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for path in candidates[keep:]:
            if path != protected:
                shutil.rmtree(path)
    for name in ("raw", "discovery", "recipe-downloads", "validator"):
        cache = state / name
        if not cache.exists():
            continue
        retained = {
            json.loads(p.read_text()).get("sha256") for p in cache.glob("*.json")
        }
        for path in cache.iterdir():
            if (
                re.fullmatch("[a-f0-9]{64}", path.name)
                and path.is_file()
                and path.name not in retained
            ):
                path.unlink()


def prepare(config, state, *, validator=None):
    """Return hash-bound prepared inputs after all gates; never activate transit."""
    keep = config.get("retainedFeedAttempts", 3)
    require(
        isinstance(keep, int) and keep >= 2,
        "retainedFeedAttempts must be >= 2 per outcome",
    )
    state = Path(state).resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "prepare.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        attempts = state / "attempts"
        attempts.mkdir(exist_ok=True)
        attempt = Path(
            tempfile.mkdtemp(
                prefix=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-"),
                dir=attempts,
            )
        )
        (attempt / "managed-by-ptn").touch()
        try:
            result = _prepare(config, state, attempt, validator)
            write_json(attempt / "result.json", result)
            write_json(
                state / "latest-validated.json",
                {
                    "result": str(attempt / "result.json"),
                    "sha256": digest(attempt / "result.json"),
                },
            )
            return result
        except Exception as error:
            write_json(
                attempt / "failure.json",
                {
                    "passed": False,
                    "error": str(error),
                    "evaluatedAt": datetime.now(timezone.utc).isoformat(),
                },
            )
            raise
        finally:
            try:
                prune_attempts(state, keep)
            except (OSError, ValueError, KeyError) as error:
                print(f"PTN GTFS retention failed: {error}", file=sys.stderr)


def _prepare(config, state, attempt, validator):
    require(
        ("gtfsURL" in config) != ("gtfsRecipe" in config),
        "choose exactly one of gtfsURL or gtfsRecipe",
    )
    if "gtfsRecipe" in config:
        definition, root, identity = recipe(config, state, attempt)
    else:
        definition = {
            "city": config.get("city", "vilnius"),
            "timezone": config.get("timezone", "Europe/Vilnius"),
            "sources": [{"id": "raw", "url": config["gtfsURL"], "steps": []}],
        }
        root, identity = None, {"mode": "raw", "url": config["gtfsURL"]}
    require(
        definition["city"] == config.get("city", "vilnius")
        and definition["timezone"] == config.get("timezone", "Europe/Vilnius"),
        "recipe city/timezone differs from host config",
    )
    sources = definition["sources"]
    require(
        sources and len({s["id"] for s in sources}) == len(sources),
        "missing/duplicate recipe components",
    )
    require(
        set(definition.get("requiredSourceIds", [s["id"] for s in sources]))
        == {s["id"] for s in sources},
        "incomplete recipe components",
    )
    version = definition.get("schemaVersion", 1)
    today = datetime.now(ZoneInfo(definition["timezone"])).date()
    floors = {
        s["id"]: freshness_floor(config, state, s["id"])
        for s in sources
        if version == 2 and "freshness" in s
    }
    credentials = config.get("credentials", [])
    require(
        isinstance(credentials, list)
        and all(
            isinstance(c, str) and ENVIRONMENT_NAME.fullmatch(c) for c in credentials
        ),
        "credentials must be a list of environment names",
    )
    records = []
    for source in sources:
        source_id = source["id"]
        require(re.fullmatch("[a-z0-9_-]+", source_id), "invalid source ID")
        directory = attempt / source_id
        directory.mkdir()
        if version == 2 and "url" in source:
            raw, retrieval = acquire(
                source,
                state,
                today=today,
                floor=floors.get(source_id),
                credentials=credentials,
            )
        else:
            url = source_url(source, state, directory)
            raw, retrieval = fetch(
                url, state / "raw", allow_http=source.get("allowHTTP", False)
            )
        shutil.copyfile(raw, directory / "raw.zip")
        write_json(directory / "retrieval.json", retrieval)
        check_zip(raw)
        reused = (
            reusable_source(state, identity, source_id, retrieval["sha256"])
            if not source.get("alwaysPrepare")
            else None
        )
        if reused:
            for path in reused.iterdir():
                if path.name not in {
                    "raw.zip",
                    "retrieval.json",
                    "discovery.json",
                    "discovery-retrieval.json",
                    "original-report",
                    "prepared-report",
                }:
                    if path.is_dir():
                        shutil.copytree(path, directory / path.name)
                    else:
                        shutil.copyfile(path, directory / path.name)
        current = directory / "raw.zip"
        for index, step in enumerate(source.get("steps", [])) if not reused else ():
            require(
                root is not None and re.fullmatch(r"scripts/[a-zA-Z0-9_-]+\.py", step),
                "invalid transformation script",
            )
            target = directory / f"step-{index}.zip"
            with (directory / f"step-{index}.log").open("w") as log:
                subprocess.run(
                    [sys.executable, str(root / step), str(current), str(target)],
                    check=True,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=1800,
                    env=child_environment(),
                )
            check_zip(target)
            current = target
        prepared = directory / "prepared.zip"
        if not reused:
            if len(sources) > 1:
                namespace_feed(current, prepared, source_id)
            else:
                shutil.copyfile(current, prepared)
        record = {
            "sourceId": source_id,
            "path": str(prepared),
            "sha256": digest(prepared),
            "original": {
                "path": str(directory / "raw.zip"),
                "sha256": retrieval["sha256"],
            },
            "retrieval": retrieval,
            "attribution": source.get("attribution"),
            "policyStatus": source.get("policyStatus"),
            "policyURL": source.get("policyURL"),
            "reusedPreparation": bool(reused),
            "idPrefix": source_id + ":" if len(sources) > 1 else "",
            "serviceCoverage": coverage(prepared, definition["timezone"]),
        }
        records.append(record)
        if source.get("verifyCompaction") and not reused:
            require(
                root is not None and len(source["steps"]) == 2,
                "invalid compaction pipeline",
            )
            subprocess.run(
                [
                    sys.executable,
                    str(root / "scripts/verify_warsaw_compaction.py"),
                    str(directory / "step-0.zip"),
                    str(current),
                    str(current) + ".trip-aliases.csv.gz",
                    str(directory / "equivalence.json"),
                ],
                check=True,
                timeout=1800,
                env=child_environment(),
            )
    if validator is None:
        validator, _ = fetch(VALIDATOR_URL, state / "validator")
    require(digest(validator) == VALIDATOR_SHA, "wrong GTFS validator checksum")
    for record in records:
        directory = Path(record["path"]).parent
        if record["original"]["sha256"] != record["sha256"]:
            try:
                record["originalCanonical"] = {
                    "blocking": False,
                    "errors": validate(
                        Path(record["original"]["path"]),
                        directory / "original-report",
                        validator,
                    ),
                }
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                record["originalCanonical"] = {"blocking": False, "error": str(error)}
        record["canonicalErrors"] = validate(
            Path(record["path"]), directory / "prepared-report", validator
        )
        record["evidenceSha256"] = {
            str(p.relative_to(directory)): digest(p)
            for p in directory.rglob("*")
            if p.is_file()
            and not any(
                part in {"original-report", "prepared-report"}
                for part in p.relative_to(directory).parts
            )
        }
    city_coverage = {
        day: any(r["serviceCoverage"][day] for r in records)
        for day in records[0]["serviceCoverage"]
    }
    # A source with a mirror needs seven days by itself, so a stale mirror
    # cannot hide behind other components; other sources keep the city rule.
    mirrored = {s["id"] for s in sources if version == 2 and "mirror" in s}
    passed = all(
        not r["canonicalErrors"]
        and (all if r["sourceId"] in mirrored else any)(r["serviceCoverage"].values())
        for r in records
    ) and all(city_coverage.values())
    result = {
        "schemaVersion": 1,
        "passed": passed,
        "city": definition["city"],
        "timezone": definition["timezone"],
        "evaluatedAt": datetime.now(timezone.utc).isoformat(),
        "recipe": identity,
        "runtimeSha256": digest(__file__),
        "validatorSha256": VALIDATOR_SHA,
        "deriveInseat": definition.get("deriveInseat", "auto"),
        "serviceCoverage": city_coverage,
        "feeds": records,
    }
    write_json(attempt / "quality.json", result)
    require(
        passed,
        f"GTFS quality or seven-day component coverage failed; see {attempt / 'quality.json'}",
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument(
        "--validator",
        type=Path,
        help="optional predownloaded, checksum-pinned validator JAR",
    )
    args = parser.parse_args()
    print(
        json.dumps(
            prepare(
                json.loads(args.config.read_text()),
                args.state,
                validator=args.validator,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (
        ValueError,
        KeyError,
        OSError,
        subprocess.SubprocessError,
        zipfile.BadZipFile,
        tarfile.TarError,
    ) as error:
        print(f"PTN GTFS: {error}", file=sys.stderr)
        sys.exit(1)
