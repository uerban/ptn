"""Change is measured against published feeds, and only real changes are kept."""

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
import zipfile

NATIVE = Path(__file__).resolve().parents[1] / "examples/native"
sys.path.insert(0, str(NATIVE))
spec = importlib.util.spec_from_file_location("native_host_published", NATIVE / "host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
published = host.published


def feed(path, stops=("Alpha", "Beta")):
    tables = {
        "stops.txt": "stop_id,stop_name\n" + "".join(f"{chr(65 + i)},{n}\n" for i, n in enumerate(stops)),
        "routes.txt": "route_id,route_type\nr,3\n",
        "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
        "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,A,1\nt,B,2\n",
        "calendar.txt": "service_id,start_date,end_date\ns,20261101,20261130\n",
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in tables.items():
            archive.writestr(name, value)
    return path


class PublishedFeeds(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.feeds = self.root / "state" / "feeds"
        self.feeds.mkdir(parents=True)

    def prepared(self, name, stops=("Alpha", "Beta")):
        path = feed(self.root / name, stops)
        return {"city": "vilnius", "feeds": [{"sourceId": "raw", "path": str(path), "sha256": published.compare(None, path)["sha256"]}]}

    def history(self):
        path = self.feeds / "change-history.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def publish(self, prepared):
        records = published.changes(self.feeds, prepared)
        published.record(self.feeds, prepared, records)
        return records

    def test_first_publication_has_no_baseline(self):
        records = self.publish(self.prepared("a.zip"))
        self.assertIsNone(records[0]["changePercent"])
        self.assertEqual(records[0]["city"], "vilnius")
        self.assertEqual(len(self.history()), 1)
        pointer = json.loads((self.feeds / "last-published.json").read_text())
        self.assertEqual(pointer["feeds"]["raw"]["sha256"], records[0]["sha256"])

    def test_second_publication_is_measured_against_the_first(self):
        self.publish(self.prepared("a.zip"))
        records = self.publish(self.prepared("b.zip", ("Alpha", "Renamed")))
        self.assertEqual(records[0]["tables"]["stops"]["changed"], 1)
        self.assertEqual(records[0]["changePercent"], 50.0)
        self.assertEqual(len(self.history()), 2)

    def test_identical_bytes_append_nothing(self):
        prepared = self.prepared("a.zip")
        self.publish(prepared)
        records = self.publish(prepared)
        self.assertTrue(records[0]["identical"])
        self.assertEqual(len(self.history()), 1)

    def test_unpublished_candidates_do_not_move_the_baseline(self):
        self.publish(self.prepared("a.zip"))
        published.changes(self.feeds, self.prepared("b.zip", ("Alpha", "Renamed")))
        records = published.changes(self.feeds, self.prepared("c.zip", ("Other", "Renamed")))
        self.assertEqual(records[0]["tables"]["stops"]["changed"], 2)
        self.assertEqual(len(self.history()), 1)

    def test_retained_copy_that_differs_from_the_record_is_not_a_baseline(self):
        self.publish(self.prepared("a.zip"))
        feed(self.feeds / "published" / "raw.zip", ("Tampered", "Beta"))
        records = published.changes(self.feeds, self.prepared("b.zip"))
        self.assertIsNone(records[0]["changePercent"])
        self.assertIn("differs", records[0]["baseline"])

    def test_unreadable_candidate_yields_an_error_record(self):
        broken = self.root / "broken.zip"
        broken.write_bytes(b"x")
        records = published.changes(self.feeds, {"city": "vilnius", "feeds": [{"sourceId": "raw", "path": str(broken), "sha256": "0"}]})
        self.assertIn("unreadable", records[0]["error"])

    def test_history_keeps_only_recent_lines(self):
        (self.feeds / "change-history.jsonl").write_text("{}\n" * 1005)
        self.publish(self.prepared("a.zip"))
        self.assertEqual(len(self.history()), published.HISTORY_LINES)
        self.assertEqual(self.history()[-1]["sourceId"], "raw")

    def test_removed_component_copy_is_dropped(self):
        (self.feeds / "published").mkdir()
        feed(self.feeds / "published" / "gone.zip")
        self.publish(self.prepared("a.zip"))
        self.assertEqual([p.name for p in (self.feeds / "published").iterdir()], ["raw.zip"])


class HostRecordsOnlySuccessfulPublication(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        (self.state / "transit").mkdir(parents=True)
        (self.state / "transit" / "pt-serve.version").write_text("1")
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({
            "stateDirectory": "state", "gtfsURL": "https://source.example/gtfs.zip",
            "artifactSource": {"kind": "local", "directory": "/osm"}, "trustedKeys": ["a" * 64],
        }))

    def refresh(self, prepared, fail=False, broken_record=False):
        def run(command, **kwargs):
            if fail and Path(command[0]).name == "pt-producer":
                raise host.subprocess.CalledProcessError(1, command)

        patches = [
            patch.object(sys, "argv", ["host.py", "--config", str(self.config), "refresh"]),
            patch.object(host, "prepare", return_value=prepared),
            patch.object(host.subprocess, "run", side_effect=run),
        ]
        if broken_record:
            patches.append(patch.object(host.published, "changes", side_effect=RuntimeError("boom")))
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as errors:
            for item in patches:
                item.start()
            try:
                host.main()
            finally:
                for item in patches:
                    item.stop()
        return errors.getvalue()

    def prepared(self, name, stops=("Alpha", "Beta")):
        path = feed(self.root / name, stops)
        return {"city": "vilnius", "deriveInseat": "auto", "feeds": [{"sourceId": "raw", "path": str(path), "sha256": published.compare(None, path)["sha256"], "idPrefix": ""}]}

    def test_failed_producer_leaves_baseline_and_history_untouched(self):
        self.refresh(self.prepared("a.zip"))
        before = (self.state / "feeds" / "last-published.json").read_bytes()
        with self.assertRaises(host.subprocess.CalledProcessError):
            self.refresh(self.prepared("b.zip", ("Alpha", "Renamed")), fail=True)
        self.assertEqual((self.state / "feeds" / "last-published.json").read_bytes(), before)
        self.assertEqual(len((self.state / "feeds" / "change-history.jsonl").read_text().splitlines()), 1)

    def test_failing_change_record_does_not_fail_the_refresh(self):
        errors = self.refresh(self.prepared("a.zip"), broken_record=True)
        self.assertIn("change record failed: boom", errors)
        self.assertTrue((self.state / "feeds" / "last-published.json").exists())


if __name__ == "__main__":
    unittest.main()
