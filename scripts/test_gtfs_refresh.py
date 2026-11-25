"""Refresh failures must never replace the last validated candidate."""

from concurrent.futures import ProcessPoolExecutor
from datetime import date, datetime, timedelta, timezone
import http.client
import importlib.util
import csv
import io
import json
from pathlib import Path
import ssl
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import zipfile

spec = importlib.util.spec_from_file_location(
    "gtfs", Path(__file__).resolve().parents[1] / "examples/native/gtfs.py"
)
gtfs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gtfs)


def fixture(path):
    tables = {
        "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\na,Synthetic,https://example.org,Europe/Riga\n",
        "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,stop_code\nA,Alpha,56.95,24.1,A\nB,Beta,56.951,24.101,B\n",
        "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nr,a,1,Alpha to Beta,3\n",
        "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
        "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,25:00:00,25:00:00,A,1\nt,25:05:00,25:05:00,B,2\nt,25:10:00,25:10:00,A,3\n",
        "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,1,1,"
        + date.today().strftime("%Y%m%d")
        + ","
        + (date.today() + timedelta(days=60)).strftime("%Y%m%d")
        + "\n",
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in tables.items():
            archive.writestr(name, value)
    return path


def archive(path, definition, extra=None):
    with tarfile.open(path, "w:gz") as output:
        content = {
            "repo/recipes/test.json": json.dumps(definition).encode(),
            **(extra or {}),
        }
        for name, data in content.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            output.addfile(info, io.BytesIO(data))
    return path


class RecipeCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.feed = fixture(self.root / "feed.zip")
        self.state = self.root / "state"
        self.config = {"gtfsURL": "https://source.example/gtfs.zip"}

    def fake_fetch(self, url, directory, **kwargs):
        return self.feed, {
            "sha256": gtfs.digest(self.feed),
            "url": url,
            "checkedAt": "test",
        }

    def run_prepare(self, config=None, errors=None):
        with (
            patch.object(gtfs, "fetch", self.fake_fetch),
            patch.object(gtfs, "validate", return_value=errors or []),
            patch.object(gtfs, "VALIDATOR_SHA", gtfs.digest(self.feed)),
        ):
            return gtfs.prepare(config or self.config, self.state, validator=self.feed)

    def recipe_config(self, definition, extra=None):
        path = archive(self.root / "recipe.tar.gz", definition, extra)
        return {
            "gtfsRecipe": {
                "archive": str(path),
                "sha256": gtfs.digest(path),
                "name": "test",
            },
            "city": "riga",
            "timezone": "Europe/Riga",
            "credentials": ["TEST_KEY"],
        }

    def definition(self, sources):
        return {
            "schemaVersion": 1,
            "city": "riga",
            "timezone": "Europe/Riga",
            "requiredSourceIds": [s["id"] for s in sources],
            "sources": sources,
        }


class Refresh(RecipeCase):
    def test_failure_preserves_prior_pointer_and_retains_attempt(self):
        first = self.run_prepare()
        pointer = (self.state / "latest-validated.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "quality"):
            self.run_prepare(errors=[{"code": "bad"}])
        self.assertEqual(pointer, (self.state / "latest-validated.json").read_bytes())
        self.assertTrue(Path(first["feeds"][0]["original"]["path"]).exists())
        self.assertEqual(len(list((self.state / "attempts").glob("*/failure.json"))), 1)

    def test_unchanged_reuses_preparation_but_rechecks_coverage(self):
        self.run_prepare()
        second = self.run_prepare()
        self.assertTrue(second["feeds"][0]["reusedPreparation"])
        pointer = (self.state / "latest-validated.json").read_bytes()
        with (
            patch.object(gtfs, "coverage", return_value={"expired": False}),
            self.assertRaisesRegex(ValueError, "coverage"),
        ):
            self.run_prepare()
        self.assertEqual(pointer, (self.state / "latest-validated.json").read_bytes())

    def test_tampered_prepared_cache_is_not_reused(self):
        first = self.run_prepare()
        Path(first["feeds"][0]["path"]).write_bytes(b"bad")
        self.assertFalse(self.run_prepare()["feeds"][0]["reusedPreparation"])

    def test_multifeed_namespaces_colliding_ids_and_preserves_times(self):
        sources = [
            {"id": name, "url": "https://source.example/" + name}
            for name in ("one", "two")
        ]
        result = self.run_prepare(self.recipe_config(self.definition(sources)))
        self.assertEqual([r["sourceId"] for r in result["feeds"]], ["one", "two"])
        for record in result["feeds"]:
            with zipfile.ZipFile(record["path"]) as z:
                times = list(gtfs.rows(z, "stop_times.txt"))
                self.assertEqual(
                    [r["stop_id"] for r in times],
                    [record["sourceId"] + ":" + x for x in ("A", "B", "A")],
                )
                self.assertEqual(times[-1]["arrival_time"], "25:10:00")
                self.assertEqual(next(gtfs.rows(z, "stops.txt"))["stop_code"], "A")

    def test_missing_component_fails_before_fetch(self):
        definition = self.definition([{"id": "one", "url": "https://source.example"}])
        definition["requiredSourceIds"].append("two")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.run_prepare(self.recipe_config(definition))

    def test_verified_pinned_recipe_cache_needs_no_github_request(self):
        config = self.recipe_config(
            self.definition([{"id": "one", "url": "https://source.example"}])
        )
        specification = config["gtfsRecipe"]
        archive_path = Path(specification.pop("archive"))
        specification["url"] = (
            "https://api.github.com/repos/example/feed/tarball/revision"
        )
        cached = self.state / "recipe-downloads" / specification["sha256"]
        cached.parent.mkdir(parents=True)
        cached.write_bytes(archive_path.read_bytes())
        attempt = self.root / "attempt"
        attempt.mkdir()
        with patch.object(
            gtfs,
            "fetch",
            side_effect=AssertionError("GitHub request for already pinned recipe"),
        ):
            definition, _, _ = gtfs.recipe(config, self.state, attempt)
        self.assertEqual(definition["city"], "riga")

    def test_wrong_recipe_hash_never_executes_code(self):
        config = self.recipe_config(
            self.definition([{"id": "one", "url": "https://source.example"}])
        )
        config["gtfsRecipe"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.run_prepare(config)

    def test_real_recipe_step_runs_and_is_cached(self):
        step = b"import shutil,sys\nshutil.copyfile(sys.argv[1],sys.argv[2])\n"
        config = self.recipe_config(
            self.definition(
                [
                    {
                        "id": "one",
                        "url": "https://source.example",
                        "steps": ["scripts/prepare.py"],
                    }
                ]
            ),
            {"repo/scripts/prepare.py": step},
        )
        self.run_prepare(config)
        with patch.object(
            gtfs.subprocess,
            "run",
            side_effect=AssertionError("unchanged transformation ran"),
        ):
            self.assertTrue(self.run_prepare(config)["feeds"][0]["reusedPreparation"])

    def test_original_errors_are_informational_prepared_errors_are_required(self):
        step = b"import shutil,sys,zipfile\nshutil.copyfile(sys.argv[1],sys.argv[2])\nwith zipfile.ZipFile(sys.argv[2],'a') as z: z.comment=b'prepared'\n"
        config = self.recipe_config(
            self.definition(
                [
                    {
                        "id": "one",
                        "url": "https://source.example",
                        "steps": ["scripts/prepare.py"],
                    }
                ]
            ),
            {"repo/scripts/prepare.py": step},
        )
        with (
            patch.object(gtfs, "fetch", self.fake_fetch),
            patch.object(gtfs, "VALIDATOR_SHA", gtfs.digest(self.feed)),
            patch.object(gtfs, "validate", side_effect=[[{"code": "original"}], []]),
        ):
            result = gtfs.prepare(config, self.state, validator=self.feed)
        self.assertTrue(result["passed"])
        self.assertFalse(result["feeds"][0]["originalCanonical"]["blocking"])
        self.assertEqual(
            result["feeds"][0]["originalCanonical"]["errors"], [{"code": "original"}]
        )

    def test_partial_component_download_never_replaces_pointer(self):
        self.run_prepare()
        pointer = (self.state / "latest-validated.json").read_bytes()
        config = self.recipe_config(
            self.definition(
                [
                    {"id": "one", "url": "https://source.example/one"},
                    {"id": "two", "url": "https://source.example/two"},
                ]
            )
        )

        def fetch(url, *args, **kwargs):
            if url.endswith("two"):
                raise OSError("upstream unavailable")
            return self.fake_fetch(url, *args, **kwargs)

        with (
            patch.object(gtfs, "fetch", fetch),
            self.assertRaisesRegex(OSError, "upstream"),
        ):
            gtfs.prepare(config, self.state, validator=self.feed)
        self.assertEqual(pointer, (self.state / "latest-validated.json").read_bytes())

    def test_retention_keeps_current_success_after_repeated_failures(self):
        self.run_prepare()
        self.run_prepare()
        self.run_prepare()
        self.run_prepare()
        pointer = json.loads((self.state / "latest-validated.json").read_text())
        for _ in range(5):
            with self.assertRaises(ValueError):
                self.run_prepare(errors=[{"code": "bad"}])
        self.assertTrue(Path(pointer["result"]).is_file())
        attempts = list((self.state / "attempts").iterdir())
        self.assertEqual(sum((p / "result.json").exists() for p in attempts), 3)
        self.assertEqual(sum((p / "failure.json").exists() for p in attempts), 3)

    def test_calendar_removal_overrides_weekly_service(self):
        with zipfile.ZipFile(self.feed, "a") as z:
            z.writestr(
                "calendar_dates.txt",
                "service_id,date,exception_type\ns,"
                + date.today().strftime("%Y%m%d")
                + ",2\n",
            )
        self.assertFalse(gtfs.coverage(self.feed, "UTC")[date.today().isoformat()])

    def test_unknown_namespace_references_fail_closed(self):
        with zipfile.ZipFile(self.feed, "a") as z:
            z.writestr("new_extension.txt", "linked_trip_id\nt\n")
        with self.assertRaisesRegex(ValueError, "unsupported table"):
            gtfs.namespace_feed(self.feed, self.root / "out.zip", "one")

    def test_namespace_scopes_route_networks(self):
        with zipfile.ZipFile(self.feed, "a") as z:
            z.writestr("networks.txt", "network_id,network_name\nn,City\n")
            z.writestr("route_networks.txt", "network_id,route_id\nn,r\n")
        out = self.root / "out.zip"
        gtfs.namespace_feed(self.feed, out, "one")
        with zipfile.ZipFile(out) as z:
            self.assertEqual(
                z.read("networks.txt").decode(), "network_id,network_name\none:n,City\n"
            )
            self.assertEqual(
                z.read("route_networks.txt").decode(), "network_id,route_id\none:n,one:r\n"
            )

    def test_namespace_scopes_route_network_column(self):
        source = self.root / "column.zip"
        with zipfile.ZipFile(source, "w") as z:
            z.writestr("routes.txt", "route_id,route_type,network_id\nr,3,n\ns,3,\n")
        out = self.root / "out.zip"
        gtfs.namespace_feed(source, out, "one")
        with zipfile.ZipFile(out) as z:
            self.assertEqual(
                z.read("routes.txt").decode(),
                "route_id,route_type,network_id\none:r,3,one:n\none:s,3,\n",
            )

    def test_unknown_namespace_id_field_fails_closed(self):
        source = self.root / "unknown.zip"
        with zipfile.ZipFile(source, "w") as z:
            z.writestr("networks.txt", "network_id,linked_network_id\nn,m\n")
        with self.assertRaisesRegex(ValueError, "unknown ID field"):
            gtfs.namespace_feed(source, self.root / "out.zip", "one")

    def test_archive_traversal_and_links_refused(self):
        for name, kind in [
            ("repo/../../escape", tarfile.REGTYPE),
            ("repo/scripts/link", tarfile.SYMTYPE),
        ]:
            path = self.root / "unsafe.tar.gz"
            with tarfile.open(path, "w:gz") as z:
                info = tarfile.TarInfo(name)
                info.type = kind
                z.addfile(info)
            with self.assertRaises(ValueError):
                gtfs.unpack_recipe(path, self.root / "unpack")


class HTTP(unittest.TestCase):
    class Response(io.BytesIO):
        status = 200
        headers = {"ETag": '"feed-v1"'}

        def geturl(self):
            return "https://source.example/feed.zip"

    def test_conditional_fetch_and_corrupted_cache_refetch(self):
        with (
            tempfile.TemporaryDirectory() as work,
            patch.object(gtfs.urllib.request, "build_opener") as builder,
        ):
            opener = builder.return_value
            opener.open.return_value = self.Response(b"source bytes")
            path, record = gtfs.fetch("https://source.example/feed.zip", Path(work))
            self.assertEqual(record["httpStatus"], 200)
            opener.open.side_effect = urllib.error.HTTPError(
                "https://source.example/feed.zip", 304, "unchanged", {}, None
            )
            self.assertEqual(
                gtfs.fetch("https://source.example/feed.zip", Path(work))[1][
                    "httpStatus"
                ],
                304,
            )
            self.assertEqual(
                opener.open.call_args.args[0].get_header("If-none-match"), '"feed-v1"'
            )
            path.write_bytes(b"corrupt")
            opener.open.side_effect = None
            opener.open.return_value = self.Response(b"source bytes")
            gtfs.fetch("https://source.example/feed.zip", Path(work))
            self.assertIsNone(opener.open.call_args.args[0].get_header("If-none-match"))

    def test_authenticated_archive_redirect_query_is_not_retained(self):
        with (
            tempfile.TemporaryDirectory() as work,
            patch.object(gtfs.urllib.request, "build_opener") as builder,
        ):
            response = self.Response(b"archive")
            response.geturl = lambda: (
                "https://codeload.github.com/archive?token=temporary-secret"
            )
            builder.return_value.open.return_value = response
            _, record = gtfs.fetch(
                "https://api.github.com/repos/example/feed/tarball/revision",
                Path(work),
                token="credential",
            )
            self.assertEqual(
                record["resolvedURL"], "https://codeload.github.com/archive"
            )
            self.assertNotIn("temporary-secret", json.dumps(record))

    def test_partial_download_does_not_commit_metadata(self):
        with (
            tempfile.TemporaryDirectory() as work,
            patch.object(gtfs.urllib.request, "build_opener") as builder,
        ):
            response = self.Response(b"partial")
            response.headers = {"Content-Length": "999"}
            builder.return_value.open.return_value = response
            with self.assertRaisesRegex(ValueError, "truncated"):
                gtfs.fetch("https://source.example/feed.zip", Path(work))
            self.assertEqual(list(Path(work).iterdir()), [])

    def test_credentials_not_forwarded_to_redirect_host(self):
        request = urllib.request.Request(
            "https://api.github.com/repos/example/feed/tarball",
            headers={"Authorization": "Bearer secret"},
        )
        redirected = gtfs.Redirect().redirect_request(
            request, None, 302, "found", {}, "https://codeload.github.com/example/feed"
        )
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaisesRegex(ValueError, "downgrade"):
            gtfs.Redirect().redirect_request(
                request, None, 302, "found", {}, "http://example.com/feed"
            )

    def test_riga_discovery_uses_schedule_month_not_modification_date(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            metadata = root / "metadata.json"
            metadata.write_text(
                json.dumps(
                    {
                        "success": True,
                        "result": {
                            "resources": [
                                {
                                    "name": "MarsrutuSaraksti01_2026.zip",
                                    "url": "https://data.gov.lv/january",
                                    "last_modified": "2099",
                                },
                                {
                                    "name": "MarsrutuSaraksti10_2026.zip",
                                    "url": "https://data.gov.lv/october",
                                },
                            ]
                        },
                    }
                )
            )
            with patch.object(gtfs, "fetch", return_value=(metadata, {})):
                directory = root / "attempt"
                directory.mkdir()
                self.assertEqual(
                    gtfs.source_url(
                        {
                            "discovery": {
                                "kind": "riga-ckan-monthly-v1",
                                "url": "https://data.gov.lv/api",
                            }
                        },
                        root,
                        directory,
                    ),
                    "https://data.gov.lv/october",
                )


def versioned(path, version=None, agencies=("Synthetic",), feed_id="SE-x"):
    base = fixture(path.with_name(path.name + ".base"))
    with zipfile.ZipFile(base) as incoming, zipfile.ZipFile(path, "w") as z:
        for name in incoming.namelist():
            if name != "agency.txt":
                z.writestr(name, incoming.read(name))
        z.writestr(
            "agency.txt",
            "agency_id,agency_name,agency_url,agency_timezone\n"
            + "".join(f"{'a' if i == 0 else f'a{i}'},{n},https://example.org,Europe/Riga\n" for i, n in enumerate(agencies)),
        )
        if version is not None:
            z.writestr(
                "feed_info.txt",
                "feed_publisher_name,feed_publisher_url,feed_lang,feed_id,feed_version\n"
                f"P,https://example.org,sv,{feed_id},{version}\n",
            )
    return path


ORIGIN = "https://origin.example/feed.zip"
MIRROR = "https://mirror.example/latest.zip"


class Sources(unittest.TestCase):
    """Schema 2: origin plus mirror, freshness, identity, budget, floor."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.today = date(2026, 11, 22)
        self.responses, self.calls = {}, []
        environment = patch.dict(gtfs.os.environ, {"PT_FEEDS_BUDGET_DIR": str(self.root / "budget")})
        environment.start()
        self.addCleanup(environment.stop)

    def serve(self, url, value):
        self.responses[url] = value

    def fake_fetch(self, url, directory, *, allow_http=False, query_secret=None, **kwargs):
        self.calls.append((url, query_secret))
        value = self.responses[url]
        if isinstance(value, BaseException):
            raise value
        return value, {"url": url, "sha256": gtfs.digest(value), "httpStatus": 200}

    def zip(self, name, **kwargs):
        return versioned(self.root / name, **kwargs)

    def source(self, **extra):
        source = {
            "id": "sl",
            "url": ORIGIN,
            "mirror": {"operator": "Mirror Org", "url": MIRROR},
            "prefer": "mirror",
            "freshness": {"signal": "feed_info.feed_version", "format": "%Y-%m-%d", "maxAgeDays": 0},
            "identity": {"feedInfo": {"feed_id": "SE-x"}, "agencyNames": ["Synthetic"]},
        }
        source.update(extra)
        gtfs.check_source(source)
        return source

    def acquire(self, source, floor=None, credentials=("TEST_KEY",)):
        with patch.object(gtfs, "fetch", self.fake_fetch):
            return gtfs.acquire(
                source, self.state, today=self.today, floor=floor, credentials=credentials
            )

    def test_fresh_mirror_leaves_origin_untouched(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-22"))
        raw, record = self.acquire(self.source())
        self.assertEqual([c[0] for c in self.calls], [MIRROR])
        self.assertEqual(record["candidate"], {"kind": "mirror", "operator": "Mirror Org"})
        self.assertEqual(record["freshness"]["ageDays"], 0)

    def test_yesterdays_mirror_falls_through_to_origin(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-21"))
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        _, record = self.acquire(self.source())
        self.assertEqual(record["candidate"]["kind"], "origin")
        self.assertEqual([a["outcome"] for a in record["attempts"]], ["stale", "accepted"])

    def test_all_stale_uses_freshest_and_warns(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-20"))
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-21"))
        _, record = self.acquire(self.source())
        self.assertEqual(record["candidate"]["kind"], "origin")
        self.assertTrue(record["freshness"]["stale"])
        self.assertIn("no fresh candidate", " ".join(record["warnings"]))

    def test_wrong_feed_on_mirror_falls_back_but_origin_is_hard(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-22", feed_id="OTHER"))
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        self.assertEqual(self.acquire(self.source())[1]["candidate"]["kind"], "origin")
        self.serve(ORIGIN, self.zip("o2.zip", version="2026-11-22", agencies=("Other",)))
        with self.assertRaisesRegex(gtfs.SourceError, "origin identity"):
            self.acquire(self.source(prefer="origin"))

    def test_agency_count_rejects_superset(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-22", agencies=("Synthetic", "Extra")))
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        source = self.source(identity={"agencyNames": ["Synthetic"], "agencyCount": 1})
        self.assertEqual(self.acquire(source)[1]["candidate"]["kind"], "origin")

    def test_origin_html_falls_back_to_mirror_with_warning(self):
        page = self.root / "page.html"
        page.write_text("<html>maintenance</html>")
        self.serve(ORIGIN, page)
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-22"))
        _, record = self.acquire(self.source(prefer="origin"))
        self.assertEqual(record["candidate"]["kind"], "mirror")
        self.assertIn("other than a GTFS ZIP", " ".join(record["warnings"]))
        self.assertIn("mirror used for an origin-first source", record["warnings"])

    def test_transport_failures_fall_back_and_tls_is_hard(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-22"))
        for error in (
            urllib.error.HTTPError(ORIGIN, 503, "down", {}, None),
            urllib.error.HTTPError(ORIGIN, 404, "gone", {}, None),
            urllib.error.URLError(OSError("refused")),
            TimeoutError(),
            http.client.IncompleteRead(b""),
            ValueError("truncated HTTP response"),
            ssl.SSLEOFError("EOF occurred in violation of protocol"),
            urllib.error.URLError(ssl.SSLZeroReturnError("closed")),
        ):
            self.serve(ORIGIN, error)
            self.assertEqual(self.acquire(self.source(prefer="origin"))[1]["candidate"]["kind"], "mirror")
        self.serve(ORIGIN, urllib.error.URLError(ssl.SSLCertVerificationError("bad certificate")))
        with self.assertRaisesRegex(gtfs.SourceError, "tls"):
            self.acquire(self.source(prefer="origin"))
        self.serve(ORIGIN, ValueError("HTTPS downgrade redirect refused"))
        with self.assertRaises(gtfs.SourceError):
            self.acquire(self.source(prefer="origin"))

    def test_future_or_missing_version_is_unknown(self):
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        source = self.source(identity={"agencyNames": ["Synthetic"]})
        for version in ("2026-11-24", None, "not-a-date"):
            self.serve(MIRROR, self.zip(f"m{version}.zip", version=version))
            self.assertEqual(
                [a["outcome"] for a in self.acquire(source)[1]["attempts"]],
                ["freshness-unknown", "accepted"],
            )
        self.serve(ORIGIN, self.zip("o-none.zip"))
        self.serve(MIRROR, urllib.error.HTTPError(MIRROR, 500, "x", {}, None))
        _, record = self.acquire(source)
        self.assertIn("origin freshness unknown", record["warnings"])

    def test_mirror_regression_fails_but_origin_is_authoritative(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-22"))
        self.serve(ORIGIN, urllib.error.HTTPError(ORIGIN, 503, "down", {}, None))
        with self.assertRaisesRegex(gtfs.SourceError, "older than accepted"):
            self.acquire(self.source(), floor="2026-11-23")
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        _, record = self.acquire(self.source(prefer="origin"), floor="2026-11-23")
        self.assertEqual(record["candidate"]["kind"], "origin")
        self.assertIn("older than accepted", " ".join(record["warnings"]))

    def credentialed(self, **extra):
        return self.source(
            auth={"queryParam": "key", "env": "TEST_KEY"},
            budget={"requests": 2, "days": 30},
            **extra,
        )

    def test_missing_or_malformed_credential_skips_origin(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-21"))
        for value in ("", "secret-value\n", "short"):
            with patch.dict(gtfs.os.environ, {"TEST_KEY": value}):
                _, record = self.acquire(self.credentialed())
            self.assertEqual(record["attempts"][1]["outcome"], "no-credentials")
            self.assertTrue(record["freshness"]["stale"])
            self.assertNotIn("secret-value", json.dumps(record))

    def test_budget_exhaustion_uses_stale_mirror_and_counts_every_attempt(self):
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-21"))
        self.serve(ORIGIN, urllib.error.HTTPError(ORIGIN, 503, "down", {}, None))
        with patch.dict(gtfs.os.environ, {"TEST_KEY": "secret-value"}):
            for _ in range(2):
                self.acquire(self.credentialed())
            _, record = self.acquire(self.credentialed())
        self.assertEqual(sum(1 for c in self.calls if c[0] == ORIGIN), 2)
        self.assertEqual(record["attempts"][1]["outcome"], "no-budget")
        self.assertTrue(record["freshness"]["stale"])
        self.assertEqual(self.calls[1][1], ("key", "secret-value"))

    def test_budget_is_shared_per_credential_and_rolls_over(self):
        directory = self.root / "ledger"
        budget = {"requests": 2, "days": 30}
        now = datetime(2026, 11, 22, tzinfo=timezone.utc)
        self.assertTrue(gtfs.spend_budget(directory, "KEY", budget, now))
        self.assertTrue(gtfs.spend_budget(directory, "KEY", budget, now))
        self.assertFalse(gtfs.spend_budget(directory, "KEY", budget, now))
        self.assertTrue(gtfs.spend_budget(directory, "OTHER", budget, now))
        later = now + timedelta(days=31)
        self.assertTrue(gtfs.spend_budget(directory, "KEY", budget, later))
        self.assertTrue(gtfs.spend_budget(directory, "KEY", budget, later))
        self.assertFalse(gtfs.spend_budget(directory, "KEY", budget, later))

    def test_short_window_never_erases_long_window_history(self):
        directory = self.root / "ledger"
        now = datetime(2026, 11, 22, tzinfo=timezone.utc)
        long, short = {"requests": 3, "days": 30}, {"requests": 5, "days": 1}
        for day in range(3):
            self.assertTrue(gtfs.spend_budget(directory, "KEY", long, now - timedelta(days=day + 2)))
        self.assertTrue(gtfs.spend_budget(directory, "KEY", short, now))
        self.assertFalse(gtfs.spend_budget(directory, "KEY", long, now))

    def test_lagging_mirror_below_floor_tries_origin(self):
        source = self.source(freshness={"signal": "feed_info.feed_version", "format": "%Y-%m-%d", "maxAgeDays": 3})
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-20"))
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        _, record = self.acquire(source, floor="2026-11-21")
        self.assertEqual(record["candidate"]["kind"], "origin")
        self.assertEqual([a["outcome"] for a in record["attempts"]], ["regressed", "accepted"])

    def windowed(self, name, first, last, calendar=False):
        """A feed whose service runs from `first` to `last` (YYYYMMDD), no feed_version."""
        path = self.zip(name)
        with zipfile.ZipFile(path) as z:
            members = {n: z.read(n) for n in z.namelist() if n not in {"calendar.txt", "calendar_dates.txt"}}
        with zipfile.ZipFile(path, "w") as z:
            for n, data in members.items():
                z.writestr(n, data)
            if calendar:
                z.writestr(
                    "calendar.txt",
                    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
                    f"s,1,1,1,1,1,1,1,{first},{last}\n",
                )
            else:
                z.writestr("calendar_dates.txt", f"service_id,date,exception_type\ns,{first},1\ns,{last},1\ns,{last},2\n")
        return path

    def first_date_source(self, max_age=7):
        return self.source(
            prefer="origin",
            freshness={"signal": "service.firstDate", "maxAgeDays": max_age},
            identity={"agencyNames": ["Synthetic"]},
        )

    def test_first_service_date_reads_calendar_and_dates(self):
        self.assertEqual(
            gtfs.first_service_date(self.windowed("c.zip", "20261119", "20261203", calendar=True)),
            date(2026, 11, 19),
        )
        self.assertEqual(
            gtfs.first_service_date(self.windowed("d.zip", "20261123", "20261207")),
            date(2026, 11, 23),
        )

    def test_mirror_older_than_served_never_replaces_it(self):
        # Publisher down; the mirror still has a file published before the served one.
        self.serve(ORIGIN, urllib.error.URLError(OSError("refused")))
        self.serve(MIRROR, self.windowed("m.zip", "20261119", "20261203"))
        with self.assertRaisesRegex(gtfs.SourceError, "mirror data 2026-11-19 is older than accepted 2026-11-21"):
            self.acquire(self.first_date_source(), floor="2026-11-21")

    def test_newer_shorter_file_counts_as_fresher(self):
        # Served: a half-year file from 2026-11-01. The mirror's newer file reaches one month.
        self.serve(ORIGIN, urllib.error.URLError(OSError("refused")))
        self.serve(MIRROR, self.windowed("m.zip", "20261120", "20261220"))
        _, record = self.acquire(self.first_date_source(), floor="2026-11-01")
        self.assertEqual(record["candidate"]["kind"], "mirror")
        self.assertEqual(record["freshness"]["value"], "2026-11-20")
        self.assertEqual(record["freshness"]["ageDays"], 2)

    def test_stale_origin_falls_back_to_fresher_mirror(self):
        self.serve(ORIGIN, self.windowed("o.zip", "20261110", "20270510"))
        self.serve(MIRROR, self.windowed("m.zip", "20261121", "20261205"))
        _, record = self.acquire(self.first_date_source(max_age=7))
        self.assertEqual(record["candidate"]["kind"], "mirror")
        self.assertEqual([a["outcome"] for a in record["attempts"]], ["stale", "accepted"])

    def test_mirror_without_service_dates_is_skipped(self):
        empty = self.windowed("m.zip", "", "")
        with zipfile.ZipFile(empty) as z:
            members = {n: z.read(n) for n in z.namelist() if n != "calendar_dates.txt"}
        with zipfile.ZipFile(empty, "w") as z:
            for n, data in members.items():
                z.writestr(n, data)
        self.serve(ORIGIN, urllib.error.URLError(OSError("refused")))
        self.serve(MIRROR, empty)
        with self.assertRaisesRegex(gtfs.SourceError, "mirror freshness-unknown"):
            self.acquire(self.first_date_source())

    def test_first_date_signal_takes_no_format(self):
        gtfs.check_source(self.first_date_source())
        for freshness in (
            {"signal": "service.firstDate", "format": "%Y%m%d", "maxAgeDays": 0},
            {"signal": "feed_info.feed_version", "maxAgeDays": 0},
            {"signal": "service.lastDate", "maxAgeDays": 0},
        ):
            with self.assertRaises(ValueError, msg=json.dumps(freshness)):
                self.source(freshness=freshness)

    def test_unreadable_mirror_metadata_is_skipped_origin_is_hard(self):
        broken = self.zip("broken.zip", version="2026-11-22")
        with zipfile.ZipFile(broken) as z:
            members = {n: z.read(n) for n in z.namelist()}
        members["agency.txt"] = b"agency_id,agency_name\na,Synthetic,extra\n"
        with zipfile.ZipFile(broken, "w") as z:
            for name, data in members.items():
                z.writestr(name, data)
        # A ragged raw row is tolerated: recipe steps repair it later.
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-20"))
        self.serve(ORIGIN, broken)
        self.assertEqual(self.acquire(self.source(prefer="origin"))[1]["candidate"]["kind"], "origin")
        self.serve(MIRROR, broken)
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        real = gtfs.table

        def failing(path, name):
            if Path(path) == broken:
                raise csv.Error("line contains NUL")
            return real(path, name)

        with patch.object(gtfs, "table", failing):
            _, record = self.acquire(self.source())
            self.assertEqual([a["outcome"] for a in record["attempts"]], ["unreadable", "accepted"])
            self.serve(ORIGIN, broken)
            with self.assertRaisesRegex(gtfs.SourceError, "unreadable"):
                self.acquire(self.source(prefer="origin"))

    def test_identity_ignores_whitespace_and_unicode_form(self):
        padded = self.root / "padded.zip"
        with zipfile.ZipFile(padded, "w") as z:
            z.writestr("agency.txt", "agency_id, agency_name\na,  Zarza\u0328d \n")
            z.writestr("feed_info.txt", "feed_publisher_name ,feed_lang\n Zarz\u0105d ,pl\n")
        identity = {"feedInfo": {"feed_publisher_name": "Zarz\u0105d"}, "agencyNames": ["Zarz\u0105d"], "agencyCount": 1}
        self.assertIsNone(gtfs.identity_problem(padded, identity))

    def test_mirror_hard_failure_and_credentialed_redirect_fall_back(self):
        self.serve(MIRROR, urllib.error.URLError(ssl.SSLCertVerificationError("bad certificate")))
        self.serve(ORIGIN, self.zip("o.zip", version="2026-11-22"))
        _, record = self.acquire(self.source())
        self.assertEqual(record["candidate"]["kind"], "origin")
        self.assertIn("mirror tls failure", record["warnings"])
        self.serve(MIRROR, self.zip("m.zip", version="2026-11-22"))
        self.serve(ORIGIN, gtfs.SourceError("credentialed cross-host redirect refused", transport=True, outcome="redirect"))
        self.assertEqual(self.acquire(self.source(prefer="origin"))[1]["candidate"]["kind"], "mirror")

    def test_concurrent_spend_never_exceeds_budget(self):
        directory = self.root / "ledger"
        budget = {"requests": 5, "days": 30}
        with ProcessPoolExecutor(4) as pool:
            granted = list(pool.map(spend, [str(directory)] * 20, [budget] * 20))
        self.assertEqual(sum(granted), 5)

    def test_shape_validation(self):
        good = self.source()
        bad = [
            {**good, "unknown": 1},
            {**good, "mirror": {"operator": "M", "url": "http://mirror.example/x.zip"}},
            {**good, "mirror": {"operator": "M", "url": ORIGIN}},
            {**good, "prefer": "fastest"},
            {k: v for k, v in good.items() if k != "identity"},
            {"id": "x", "discovery": {"kind": "riga-ckan-monthly-v1", "url": ORIGIN}, "mirror": good["mirror"]},
            {"id": "x", "url": ORIGIN, "discovery": {}},
            {"id": "x", "url": ORIGIN, "budget": {"requests": 1, "days": 1}},
            {"id": "x", "url": ORIGIN, "auth": {"queryParam": "key", "env": "lower"}},
            {"id": "x", "url": ORIGIN, "auth": {"queryParam": "key", "env": "K"}, "allowHTTP": True},
            {**good, "freshness": {"signal": "Last-Modified", "format": "%Y", "maxAgeDays": 0}},
        ]
        for source in bad:
            with self.assertRaises(ValueError, msg=json.dumps(source)):
                gtfs.check_source(source)


def spend(directory, budget):
    return gtfs.spend_budget(Path(directory), "KEY", budget)


class Credentials(unittest.TestCase):
    class Response(io.BytesIO):
        status = 200
        headers = {}

        def __init__(self, data, url):
            super().__init__(data)
            self.url = url

        def geturl(self):
            return self.url

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)

    def test_key_reaches_request_only(self):
        with patch.object(gtfs.urllib.request, "build_opener") as builder:
            builder.return_value.open.return_value = self.Response(
                b"bytes", "https://origin.example/feed.zip?key=s3cret.value~1&x=1"
            )
            path, record = gtfs.fetch(
                "https://origin.example/feed.zip", self.work, query_secret=("key", "s3cret.value~1")
            )
            sent = builder.return_value.open.call_args.args[0].full_url
            self.assertTrue(sent.endswith("?key=s3cret.value~1"))
            builder.return_value.open.side_effect = urllib.error.HTTPError(sent, 304, "same", {}, None)
            _, cached = gtfs.fetch(
                "https://origin.example/feed.zip", self.work, query_secret=("key", "s3cret.value~1")
            )
        self.assertEqual(record["resolvedURL"], "https://origin.example/feed.zip")
        for name in [p.name for p in self.work.iterdir()]:
            self.assertNotIn("s3cret", name)
        for text in [p.read_text() for p in self.work.glob("*.json")] + [json.dumps(record), json.dumps(cached)]:
            self.assertNotIn("s3cret", text)

    def test_errors_never_carry_key(self):
        failures = [
            urllib.error.HTTPError("https://origin.example/f?key=s3cret-value", 403, "no", {}, None),
            http.client.InvalidURL("URL can't contain control characters. 'key=s3cret-value'"),
            urllib.error.URLError(OSError("s3cret-value")),
        ]
        for failure in failures:
            with patch.object(gtfs.urllib.request, "build_opener") as builder:
                builder.return_value.open.side_effect = failure
                with self.assertRaises(gtfs.SourceError) as caught:
                    gtfs.fetch("https://origin.example/f", self.work, query_secret=("key", "s3cret-value"))
            error = caught.exception
            self.assertNotIn("s3cret", str(error))
            self.assertIsNone(error.__context__)
            self.assertIsNone(error.__cause__)

    def test_malformed_key_is_refused_before_any_request(self):
        with patch.object(gtfs.urllib.request, "build_opener") as builder:
            for value in ("s3cret-value\n", "s3cret value", "short"):
                with self.assertRaises(ValueError) as caught:
                    gtfs.fetch("https://origin.example/f", self.work, query_secret=("key", value))
                self.assertNotIn("s3cret", str(caught.exception))
            builder.assert_not_called()

    def test_credentialed_cross_host_redirect_refused(self):
        request = urllib.request.Request("https://origin.example/f?key=s3cret-value")
        with self.assertRaises(gtfs.SourceError):
            gtfs.Redirect(True).redirect_request(
                request, None, 302, "found", {}, "https://elsewhere.example/f?key=s3cret-value"
            )
        self.assertIsNotNone(
            gtfs.Redirect(True).redirect_request(
                request, None, 302, "found", {}, "https://origin.example/g"
            )
        )

    def test_old_call_shapes_still_work(self):
        with patch.object(gtfs.urllib.request, "build_opener") as builder:
            builder.return_value.open.return_value = self.Response(b"x", "https://a.example/f")
            self.assertEqual(gtfs.fetch("https://a.example/f", self.work)[1]["httpStatus"], 200)
            builder.return_value.open.side_effect = urllib.error.HTTPError("u", 500, "x", {}, None)
            with self.assertRaises(urllib.error.HTTPError):
                gtfs.fetch("https://a.example/f", self.work)

    def test_child_processes_lose_credentials(self):
        with patch.dict(gtfs.os.environ, {"TEST_SCRUB_KEY": "s3cret-value"}):
            gtfs.SECRET_ENVIRONMENT.add("TEST_SCRUB_KEY")
            self.addCleanup(gtfs.SECRET_ENVIRONMENT.discard, "TEST_SCRUB_KEY")
            self.assertNotIn("TEST_SCRUB_KEY", gtfs.child_environment())
        with patch.dict(gtfs.os.environ, {"PT_FEEDS_TOKEN": "github-token"}):
            self.assertNotIn("PT_FEEDS_TOKEN", gtfs.child_environment())


class PrepareV2(RecipeCase):
    """Schema 2 recipes through prepare(): floor, coverage, reuse, redaction."""

    def setUp(self):
        super().setUp()
        environment = patch.dict(
            gtfs.os.environ,
            {"PT_FEEDS_BUDGET_DIR": str(self.root / "budget"), "TEST_KEY": "s3cret-value"},
        )
        environment.start()
        self.addCleanup(environment.stop)
        self.version = None
        self.mirror_version = None

    def today(self):
        return gtfs.datetime.now(gtfs.ZoneInfo("Europe/Riga")).date()

    def fake_fetch(self, url, directory, **kwargs):
        version = self.mirror_version if "mirror" in url else self.version
        if isinstance(version, BaseException):
            raise version
        path = versioned(self.root / f"{abs(hash((url, version)))}.zip", version=version)
        return path, {"sha256": gtfs.digest(path), "url": url, "checkedAt": "test", "httpStatus": 200}

    def v2(self, **extra):
        source = {
            "id": "one",
            "url": "https://origin.example/feed.zip",
            "mirror": {"operator": "Mirror Org", "url": "https://mirror.example/latest.zip"},
            "prefer": "mirror",
            "auth": {"queryParam": "key", "env": "TEST_KEY"},
            "freshness": {"signal": "feed_info.feed_version", "format": "%Y-%m-%d", "maxAgeDays": 0},
            "identity": {"agencyNames": ["Synthetic"]},
            **extra,
        }
        definition = self.definition([source])
        definition["schemaVersion"] = 2
        return self.recipe_config(definition)

    def test_floor_from_validated_result_blocks_mirror_regression(self):
        today = self.today()
        self.mirror_version = today.isoformat()
        config = self.v2()
        first = self.run_prepare(config)
        self.assertEqual(first["feeds"][0]["retrieval"]["candidate"]["kind"], "mirror")
        self.mirror_version = (today - timedelta(days=1)).isoformat()
        self.version = urllib.error.HTTPError("u", 503, "down", {}, None)
        with self.assertRaisesRegex(gtfs.SourceError, "older than accepted"):
            self.run_prepare(config)
        failure = next((self.state / "attempts").glob("*/failure.json")).read_text()
        self.assertNotIn("s3cret", failure)
        # A configured floor can raise the validated floor but never lower it.
        config["freshnessFloors"] = {"one": (today - timedelta(days=3)).isoformat()}
        with self.assertRaisesRegex(gtfs.SourceError, "older than accepted"):
            self.run_prepare(config)
        self.assertEqual(
            gtfs.freshness_floor(
                {"freshnessFloors": {"one": (today + timedelta(days=1)).isoformat()}},
                self.state,
                "one",
            ),
            (today + timedelta(days=1)).isoformat(),
        )
        with self.assertRaisesRegex(ValueError, "YYYY-MM-DD"):
            gtfs.freshness_floor({"freshnessFloors": {"one": 20261105}}, self.state, "one")

    def test_wiped_state_without_floor_accepts(self):
        self.mirror_version = (self.today() - timedelta(days=1)).isoformat()
        self.version = urllib.error.HTTPError("u", 503, "down", {}, None)
        result = self.run_prepare(self.v2())
        self.assertNotIn("floor", result["feeds"][0]["retrieval"])

    def test_identical_bytes_reuse_preparation(self):
        self.mirror_version = self.today().isoformat()
        config = self.v2()
        self.run_prepare(config)
        self.assertTrue(self.run_prepare(config)["feeds"][0]["reusedPreparation"])

    def test_v2_needs_seven_days_from_every_source(self):
        week = [self.today() + timedelta(days=i) for i in range(7)]
        full = {d.isoformat(): True for d in week}
        short = {d.isoformat(): i < 3 for i, d in enumerate(week)}
        plain = {"id": "one", "url": "https://source.example/one"}
        mirrored = {
            "id": "two",
            "url": "https://source.example/two",
            "mirror": {"operator": "Mirror Org", "url": "https://mirror.example/two.zip"},
            "identity": {"agencyNames": ["Synthetic"]},
        }
        # Only a source with a mirror must cover seven days alone.
        cases = (
            (1, [plain, dict(plain, id="two")], True),
            (2, [plain, dict(plain, id="two")], True),
            (2, [plain, mirrored], False),
        )
        for version, sources, expect_pass in cases:
            definition = self.definition(sources)
            definition["schemaVersion"] = version
            with patch.object(gtfs, "coverage", side_effect=[full, short]):
                if expect_pass:
                    self.assertTrue(self.run_prepare(self.recipe_config(definition))["passed"])
                else:
                    with self.assertRaisesRegex(ValueError, "coverage"):
                        self.run_prepare(self.recipe_config(definition))

    def test_credentials_need_host_allowlist_and_never_runtime_names(self):
        self.version = self.today().isoformat()
        self.mirror_version = (self.today() - timedelta(days=5)).isoformat()
        config = self.v2(prefer="origin")
        config["credentials"] = []
        retrieval = self.run_prepare(config)["feeds"][0]["retrieval"]
        self.assertIn("origin credential not allowed by host configuration", retrieval["warnings"])
        self.assertEqual(retrieval["candidate"]["kind"], "mirror")
        for env in ("PT_FEEDS_TOKEN", "GITHUB_TOKEN", "PTN_REFRESH_KEY"):
            with self.assertRaisesRegex(ValueError, "runtime variable"):
                gtfs.check_source(
                    {"id": "a", "url": "https://p.example/f.zip", "auth": {"queryParam": "k", "env": env}}
                )
        with self.assertRaisesRegex(ValueError, "already sets the credential"):
            gtfs.check_source(
                {"id": "a", "url": "https://p.example/f.zip?k=x", "auth": {"queryParam": "k", "env": "KEY"}}
            )

    def test_recipe_shape_guards(self):
        mirror = {"operator": "M", "url": "https://m.example/f.zip"}
        base = {"id": "a", "url": "https://p.example/f.zip", "mirror": mirror, "identity": {"agencyNames": ["A"]}}
        with self.assertRaisesRegex(ValueError, "mirror-first source needs freshness"):
            gtfs.check_source(dict(base, prefer="mirror"))
        gtfs.check_source(base)
        auth = {"queryParam": "k", "env": "SOME_KEY"}
        with self.assertRaisesRegex(ValueError, "at most 400"):
            gtfs.check_source({"id": "a", "url": "https://p.example/f.zip", "auth": auth, "budget": {"requests": 1, "days": 401}})
        with self.assertRaisesRegex(ValueError, "auth needs"):
            gtfs.check_source({"id": "a", "url": "https://p.example/f.zip", "auth": {"queryParam": 5, "env": "K"}})
        definition = self.definition([{"id": "one", "url": "https://source.example/one", "auth": auth}])
        definition["schemaVersion"] = 2
        definition["requiredEnvironment"] = ["SOME_KEY"]
        with self.assertRaisesRegex(ValueError, "cannot also be requiredEnvironment"):
            self.run_prepare(self.recipe_config(definition))

    def test_host_credentials_never_reach_steps(self):
        with patch.dict(gtfs.os.environ, {"HOST_ONLY_KEY": "abcdefgh12"}):
            definition = self.definition([{"id": "one", "url": "https://source.example/one"}])
            config = self.recipe_config(definition)
            config["credentials"] = ["HOST_ONLY_KEY"]
            self.run_prepare(config)
            self.assertNotIn("HOST_ONLY_KEY", gtfs.child_environment())
            definition["requiredEnvironment"] = ["PT_FEEDS_TOKEN"]
            with self.assertRaisesRegex(ValueError, "never passed"):
                self.run_prepare(self.recipe_config(definition))

    def test_floor_follows_an_older_origin_version(self):
        today = self.today()
        self.mirror_version = today.isoformat()
        config = self.v2(prefer="origin")
        self.version = today.isoformat()
        self.run_prepare(config)
        self.version = (today - timedelta(days=2)).isoformat()
        self.mirror_version = (today - timedelta(days=9)).isoformat()
        self.run_prepare(config)
        self.assertEqual(gtfs.freshness_floor({}, self.state, "one"), self.version)

    def test_floor_survives_a_versionless_accepted_run(self):
        today = self.today()
        self.mirror_version = today.isoformat()
        config = self.v2()
        self.run_prepare(config)
        self.mirror_version = urllib.error.HTTPError("u", 503, "down", {}, None)
        self.version = "not-a-date"
        accepted = self.run_prepare(config)["feeds"][0]["retrieval"]
        self.assertEqual(accepted["freshness"]["value"], None)
        self.assertEqual(gtfs.freshness_floor({}, self.state, "one"), today.isoformat())

    def test_schema_1_refuses_every_schema_2_key(self):
        for key, value in (("freshness", {}), ("identity", {}), ("prefer", "origin"), ("budget", {})):
            definition = self.definition([{"id": "one", "url": "https://source.example/one", key: value}])
            with self.assertRaisesRegex(ValueError, "schemaVersion 2"):
                self.run_prepare(self.recipe_config(definition))

    def test_retrieval_and_logs_carry_no_key(self):
        self.version = self.today().isoformat()
        self.mirror_version = urllib.error.URLError(OSError("refused"))
        result = self.run_prepare(self.v2())
        self.assertEqual(result["feeds"][0]["retrieval"]["candidate"]["kind"], "origin")
        for path in self.state.rglob("*"):
            if path.is_file() and path.suffix in {".json", ".log", ".ledger"}:
                self.assertNotIn("s3cret", path.read_text(), path)

    def test_schema_1_refuses_mirror(self):
        definition = self.definition(
            [{"id": "one", "url": "https://o.example/f", "mirror": {"operator": "M", "url": "https://m.example/f"}}]
        )
        with self.assertRaisesRegex(ValueError, "schemaVersion 2"):
            self.run_prepare(self.recipe_config(definition))


if __name__ == "__main__":
    unittest.main()
