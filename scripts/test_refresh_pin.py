"""A pin holds publication for a bounded time and never fails open on damage."""

from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
import zipfile

NATIVE = Path(__file__).resolve().parents[1] / "examples/native"
sys.path.insert(0, str(NATIVE))
spec = importlib.util.spec_from_file_location("native_host_pin", NATIVE / "host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
pin = host.pin
NOW = datetime(2026, 11, 16, 12, tzinfo=timezone.utc)


def feed(path, stop_name="Alpha"):
    tables = {
        "stops.txt": f"stop_id,stop_name\nA,{stop_name}\nB,Beta\n",
        "routes.txt": "route_id,route_type\nr,3\n",
        "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
        "stop_times.txt": "trip_id,stop_id,stop_sequence\nt,A,1\nt,B,2\n",
        "calendar.txt": "service_id,start_date,end_date\ns,20261101,20261130\n",
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in tables.items():
            archive.writestr(name, value)
    return path


class PinFile(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "refresh-pin.json"

    def test_absent_file_is_unpinned(self):
        self.assertIsNone(pin.read(self.path, NOW))
        self.assertEqual(pin.describe(None), "unpinned")

    def test_pin_is_active_until_it_expires(self):
        written = pin.write(self.path, " compare candidate ", 2, now=NOW)
        self.assertEqual(written["reason"], "compare candidate")
        self.assertEqual(pin.read(self.path, NOW + timedelta(hours=1))["reason"], "compare candidate")
        self.assertIsNone(pin.read(self.path, NOW + timedelta(hours=2)))

    def test_clear_removes_the_pin_and_tolerates_absence(self):
        pin.write(self.path, "x", now=NOW)
        pin.clear(self.path)
        pin.clear(self.path)
        self.assertIsNone(pin.read(self.path, NOW))

    def test_duration_and_reason_are_bounded(self):
        for hours in (0, -1, 168.5, True, "3"):
            with self.assertRaises(ValueError):
                pin.write(self.path, "x", hours, now=NOW)
        with self.assertRaises(ValueError):
            pin.write(self.path, "  ", now=NOW)
        self.assertFalse(self.path.exists())
        pin.write(self.path, "x", 168, now=NOW)

    def test_damaged_file_counts_as_pinned(self):
        for content in ("{", "{}", json.dumps({"reason": "x", "expiresAt": "2026-11-17T00:00:00"}), "[]"):
            self.path.write_text(content)
            held = pin.read(self.path, NOW)
            self.assertTrue(held["malformed"], content)
            self.assertIn("remove or rewrite", pin.describe(held))


class PinnedRefresh(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        (self.state / "transit").mkdir(parents=True)
        (self.state / "transit" / "pt-serve.version").write_text("1")
        self.config = self.root / "config.json"
        self.settings = {
            "stateDirectory": "state",
            "gtfsURL": "https://source.example/gtfs.zip",
            "artifactSource": {"kind": "local", "directory": "/osm"},
            "trustedKeys": ["a" * 64],
        }
        self.feed = feed(self.root / "prepared.zip")

    def run_host(self, *arguments, producer_fails=False):
        self.config.write_text(json.dumps(self.settings))
        prepared = {
            "city": "vilnius",
            "deriveInseat": "auto",
            "feeds": [{"sourceId": "raw", "path": str(self.feed), "sha256": host.published.compare(None, self.feed)["sha256"], "idPrefix": ""}],
        }
        commands = []

        def run(command, **kwargs):
            commands.append(Path(command[0]).name)
            if producer_fails and Path(command[0]).name == "pt-producer":
                raise host.subprocess.CalledProcessError(1, command)

        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["host.py", "--config", str(self.config), *arguments]),
            patch.object(host, "prepare", return_value=prepared) as prepare,
            patch.object(host.subprocess, "run", side_effect=run),
            patch.object(host, "run_prebuilt") as prebuilt,
            redirect_stdout(output),
        ):
            host.main()
        self.prepare_calls, self.prebuilt_calls = prepare.call_count, prebuilt.call_count
        return commands, output.getvalue()

    def test_pinned_refresh_prepares_but_never_publishes(self):
        _, text = self.run_host("pin", "--reason", "candidate comparison", "--hours", "2")
        self.assertIn("pinned until", text)
        commands, text = self.run_host("refresh")
        self.assertEqual(self.prepare_calls, 1)
        self.assertNotIn("pt-producer", commands)
        self.assertIn("publication skipped", text)
        self.assertFalse((self.state / "feeds" / "last-published.json").exists())

    def test_unpinned_and_expired_pins_publish(self):
        self.run_host("pin", "--reason", "x")
        _, text = self.run_host("unpin")
        self.assertEqual(text.strip(), "unpinned")
        commands, _ = self.run_host("refresh")
        self.assertIn("pt-producer", commands)
        pin.write(self.state / "refresh-pin.json", "old", 1, now=datetime.now(timezone.utc) - timedelta(hours=2))
        commands, _ = self.run_host("refresh")
        self.assertIn("pt-producer", commands)
        _, text = self.run_host("pin-status")
        self.assertEqual(text.strip(), "unpinned")

    def test_pin_requires_a_reason(self):
        with self.assertRaisesRegex(ValueError, "reason"):
            self.run_host("pin")

    def test_pinned_prebuilt_refresh_skips_activation_but_still_serves(self):
        self.settings["transitMode"] = "prebuilt"
        self.run_host("pin", "--reason", "x")
        _, text = self.run_host("refresh")
        self.assertEqual(self.prebuilt_calls, 0)
        self.assertIn("refresh skipped", text)
        self.run_host("serve")
        self.assertEqual(self.prebuilt_calls, 1)


if __name__ == "__main__":
    unittest.main()
