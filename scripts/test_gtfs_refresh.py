"""Refresh failures must never replace the last validated candidate."""

from datetime import date, timedelta
import importlib.util
import io
import json
from pathlib import Path
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


class Refresh(unittest.TestCase):
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
        }

    def definition(self, sources):
        return {
            "schemaVersion": 1,
            "city": "riga",
            "timezone": "Europe/Riga",
            "requiredSourceIds": [s["id"] for s in sources],
            "sources": sources,
        }

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


if __name__ == "__main__":
    unittest.main()
