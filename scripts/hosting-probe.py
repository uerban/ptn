#!/usr/bin/env python3
"""Choose a real, active direct trip for the browser installation check.

This is test selection, not a routing implementation. Calendar exceptions
override weekly service; repeated stop visits retain stop_sequence ordering.
https://gtfs.org/documentation/schedule/reference/#calendartxt
https://gtfs.org/documentation/schedule/reference/#calendar_datestxt
https://gtfs.org/documentation/schedule/reference/#stop_timestxt
"""
import csv
from datetime import datetime, timedelta
import io
import json
import sys
from zoneinfo import ZoneInfo
import zipfile


def main():
    with zipfile.ZipFile(sys.argv[1]) as archive:
        def rows(name):
            return list(csv.DictReader(io.TextIOWrapper(archive.open(name), encoding="utf-8-sig"))) if name in archive.namelist() else []
        calendar = rows("calendar.txt")
        exceptions = rows("calendar_dates.txt")
        trips = {row["trip_id"]: row for row in rows("trips.txt")}
        times = {}
        for row in rows("stop_times.txt"):
            times.setdefault(row["trip_id"], []).append(row)
        today = datetime.now(ZoneInfo("Europe/Vilnius")).date()
        for delta in range(7):
            day = today + timedelta(days=delta)
            ymd = day.strftime("%Y%m%d")
            weekday = day.strftime("%A").lower()
            active = {row["service_id"] for row in calendar if row["start_date"] <= ymd <= row["end_date"] and row[weekday] == "1"}
            for row in exceptions:
                if row["date"] == ymd:
                    (active.add if row["exception_type"] == "1" else active.discard)(row["service_id"])
            for trip_id, stops in times.items():
                if trips[trip_id]["service_id"] not in active or len(stops) < 8:
                    continue
                stops.sort(key=lambda row: int(row["stop_sequence"]))
                first, last = stops[0], stops[-1]
                if first.get("pickup_type", "0") not in ("", "0") or last.get("drop_off_type", "0") not in ("", "0") or first["stop_id"] == last["stop_id"]:
                    continue
                parts = first["departure_time"].split(":")
                if len(parts) != 3:
                    continue
                seconds = sum(int(value) * unit for value, unit in zip(parts, (3600, 60, 1)))
                if not 10 * 3600 <= seconds <= 14 * 3600:
                    continue
                # GTFS Time is seconds from local noon minus twelve elapsed
                # hours, which can differ from midnight on a DST transition.
                timezone = ZoneInfo("Europe/Vilnius")
                origin = datetime(day.year, day.month, day.day, 12, tzinfo=timezone).timestamp() - 12 * 3600
                departure = datetime.fromtimestamp(origin + seconds - 60, timezone)
                print(json.dumps({"fromStopId": first["stop_id"], "toStopId": last["stop_id"], "at": departure.isoformat(), "tripId": trip_id}))
                return
    raise SystemExit("no active daytime trip found; check GTFS freshness")


if __name__ == "__main__":
    main()
