"""Change statistics describe feed differences without deciding publication."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location(
    "feed_change", Path(__file__).resolve().parents[1] / "examples/native/feed_change.py"
)
feed_change = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed_change)

BASE = {
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,56.95,24.1\nB,Beta,56.951,24.101\nC,Gamma,56.952,24.102\nD,Delta,56.953,24.103\n",
    "routes.txt": "route_id,route_short_name,route_type\nr1,1,3\nr2,2,3\n",
    "trips.txt": "route_id,service_id,trip_id\nr1,s,t1\nr1,s,t2\nr2,s,t3\nr2,s,t4\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
    + "".join(f"t{n},08:0{i}:00,08:0{i}:00,{s},{i}\n" for n in range(1, 5) for i, s in enumerate("ABC", 1)),
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,1,1,20261101,20261130\n",
}


class FeedChange(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.count = 0

    def feed(self, **overrides):
        self.count += 1
        path = self.root / f"feed-{self.count}.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, value in {**BASE, **overrides}.items():
                if value is not None:
                    archive.writestr(name, value)
        return path

    def test_identical_bytes_skip_comparison(self):
        feed = self.feed()
        record = feed_change.compare(feed, feed)
        self.assertTrue(record["identical"])
        self.assertEqual(record["changePercent"], 0.0)
        self.assertEqual(record["previousSha256"], record["sha256"])

    def test_same_content_in_another_archive_is_no_change(self):
        record = feed_change.compare(self.feed(), self.feed(**{"extra.txt": "a\n1\n"}))
        self.assertNotIn("identical", record)
        self.assertEqual(record["changePercent"], 0.0)
        self.assertEqual(record["tables"]["stop_times"]["currentRows"], 12)

    def test_added_removed_and_changed_stops(self):
        stops = "stop_id,stop_name,stop_lat,stop_lon\nA,Alpha,56.95,24.1\nB,Renamed,56.951,24.101\nC,Gamma,56.952,24.102\nE,Epsilon,56.954,24.104\n"
        record = feed_change.compare(self.feed(), self.feed(**{"stops.txt": stops}))
        self.assertEqual(
            record["tables"]["stops"],
            {"previous": 4, "current": 4, "added": 1, "removed": 1, "changed": 1, "changePercent": 75.0},
        )
        self.assertEqual(record["tables"]["routes"]["changePercent"], 0.0)
        self.assertEqual(record["changePercent"], 75.0)

    def test_one_trip_with_changed_stop_times(self):
        times = BASE["stop_times.txt"].replace("t3,08:02:00,08:02:00,B,2", "t3,08:03:00,08:03:00,B,2")
        record = feed_change.compare(self.feed(), self.feed(**{"stop_times.txt": times}))
        self.assertEqual(record["tables"]["trips"]["changed"], 0)
        self.assertEqual(record["tables"]["stop_times"]["changed"], 1)
        self.assertEqual(record["tables"]["stop_times"]["changePercent"], 25.0)
        self.assertEqual(record["changePercent"], 25.0)

    def test_reordered_columns_and_rows_are_no_change(self):
        lines = BASE["stop_times.txt"].strip().split("\n")[1:]
        reordered = "stop_sequence,stop_id,trip_id,departure_time,arrival_time\n" + "".join(
            "{4},{3},{0},{2},{1}\n".format(*line.split(",")) for line in reversed(lines)
        )
        stops = "stop_name,stop_id,stop_lon,stop_lat\nBeta,B,24.101,56.951\nAlpha,A,24.1,56.95\nDelta,D,24.103,56.953\nGamma,C,24.102,56.952\n"
        record = feed_change.compare(self.feed(), self.feed(**{"stop_times.txt": reordered, "stops.txt": stops}))
        self.assertEqual(record["changePercent"], 0.0)
        self.assertNotIn("schemaChanged", record["tables"]["stops"])

    def test_duplicate_stop_time_rows_are_a_change(self):
        times = BASE["stop_times.txt"] + "t1,08:01:00,08:01:00,A,1\nt1,08:01:00,08:01:00,A,1\n"
        record = feed_change.compare(self.feed(), self.feed(**{"stop_times.txt": times}))
        self.assertEqual(record["tables"]["stop_times"]["changed"], 1)

    def test_new_column_is_flagged_and_compared_on_shared_columns(self):
        routes = "route_id,route_short_name,route_type,route_color\nr1,1,3,FF0000\nr2,2,3,00FF00\n"
        record = feed_change.compare(self.feed(), self.feed(**{"routes.txt": routes}))
        self.assertTrue(record["tables"]["routes"]["schemaChanged"])
        self.assertEqual(record["tables"]["routes"]["changed"], 0)

    def test_service_end_uses_calendar_and_added_dates(self):
        dates = "service_id,date,exception_type\ns,20261215,1\ns,20261231,2\n"
        record = feed_change.compare(self.feed(), self.feed(**{"calendar_dates.txt": dates}))
        self.assertEqual(record["serviceEnd"], {"previous": "2026-11-30", "current": "2026-12-15"})
        only_dates = feed_change.compare(None, self.feed(**{"calendar.txt": None, "calendar_dates.txt": dates}))
        self.assertEqual(only_dates["serviceEnd"]["current"], "2026-12-15")

    def test_no_baseline_reports_counts_without_percentages(self):
        record = feed_change.compare(None, self.feed())
        self.assertIsNone(record["previousSha256"])
        self.assertIsNone(record["changePercent"])
        self.assertEqual(record["baseline"], "none")
        self.assertEqual(record["tables"]["trips"], {"current": 4})
        self.assertEqual(record["tables"]["stop_times"], {"current": 4, "currentRows": 12})

    def test_unreadable_inputs_fail_without_a_partial_record(self):
        broken = self.root / "broken.zip"
        broken.write_bytes(b"not a zip")
        with self.assertRaisesRegex(ValueError, "unreadable"):
            feed_change.compare(self.feed(), broken)
        ragged = BASE["stops.txt"] + "E,Epsilon\n"
        with self.assertRaisesRegex(ValueError, "ragged"):
            feed_change.compare(self.feed(), self.feed(**{"stops.txt": ragged}))
        duplicate = BASE["routes.txt"] + "r1,9,3\n"
        with self.assertRaisesRegex(ValueError, "duplicate"):
            feed_change.compare(self.feed(), self.feed(**{"routes.txt": duplicate}))
        with self.assertRaisesRegex(ValueError, "unreadable|expected one"):
            feed_change.compare(self.feed(), self.feed(**{"trips.txt": None}))


if __name__ == "__main__":
    unittest.main()
