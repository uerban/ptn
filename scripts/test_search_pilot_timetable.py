import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parents[1] / 'tools/search-pilot'
spec = importlib.util.spec_from_file_location('timetable', HERE / 'timetable.py')
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


def source(*, calendar=True, days='1', exceptions=None, frequency=False, stop_changes=None, duplicate_sequence=False):
    files = {
        'agency.txt': [{'agency_timezone': 'Europe/Vilnius'}],
        'trips.txt': [{'trip_id': 'trip', 'route_id': 'route', 'service_id': 'service'}],
        'stop_times.txt': [
            {'trip_id': 'trip', 'stop_id': 'origin', 'stop_sequence': '10', 'arrival_time': '24:00:00', 'departure_time': '24:00:00', 'pickup_type': '1', 'drop_off_type': '0'},
            {'trip_id': 'trip', 'stop_id': 'loop', 'stop_sequence': '20', 'arrival_time': '24:05:00', 'departure_time': '24:05:00', 'pickup_type': '0', 'drop_off_type': '0'},
            {'trip_id': 'trip', 'stop_id': 'origin', 'stop_sequence': '30', 'arrival_time': '24:10:00', 'departure_time': '24:11:00', 'pickup_type': '0', 'drop_off_type': '0'},
            {'trip_id': 'trip', 'stop_id': 'destination', 'stop_sequence': '40', 'arrival_time': '24:20:00', 'departure_time': '24:20:00', 'pickup_type': '0', 'drop_off_type': '0'},
        ],
    }
    if calendar:
        files['calendar.txt'] = [{'service_id': 'service', **{d: days for d in t.WEEKDAYS}, 'start_date': '20261101', 'end_date': '20261130'}]
    if exceptions is not None:
        files['calendar_dates.txt'] = [{'service_id': 'service', 'date': date, 'exception_type': kind} for date, kind in exceptions]
    if frequency:
        files['frequencies.txt'] = [{'trip_id': 'trip', 'start_time': '24:00:00', 'end_time': '25:00:00', 'headway_secs': '600', 'exact_times': '1'}]
    for index, fields in (stop_changes or {}).items():
        files['stop_times.txt'][index].update(fields)
    if duplicate_sequence:
        files['stop_times.txt'][1]['stop_sequence'] = '10'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as z:
        for name, records in files.items():
            text = io.StringIO(newline='')
            fields = list(dict.fromkeys(key for row in records for key in row))
            writer = csv.DictWriter(text, fieldnames=fields, lineterminator='\r\n')
            writer.writeheader()
            writer.writerows(records)
            z.writestr(name, ('\ufeff' + text.getvalue()).encode())
    return buffer.getvalue()


def cases(feed):
    return {'schemaVersion': 1, 'sourceGTFSsha256': t.digest(feed), 'timeFrame': {'kind': 'gtfs-service-origin', 'timezone': 'Europe/Vilnius'}, 'cases': [{'id': 'loop', 'serviceDate': '20261113', 'candidates': [{'legs': [{
        'type': 'transit', 'tripId': 'trip', 'routeId': 'route', 'patternStopIds': ['origin', 'loop', 'origin', 'destination'],
        'boardStopIdx': 2, 'alightStopIdx': 3, 'fromStopId': 'origin', 'toStopId': 'destination', 'departSecs': 87060, 'arriveSecs': 87600,
    }]}]}]}


def checks(report):
    return {c['check']: c for c in report['cases'][0]['candidates'][0]['legs'][0]['checks']}


class SourceTimetableTests(unittest.TestCase):
    def evaluate(self, feed=None, edit=None):
        feed = source() if feed is None else feed
        document = cases(feed)
        if edit:
            edit(document)
        return t.build_report(feed, document)

    def test_overnight_loop_uses_explicit_second_occurrence_and_gtfs_sequence_not_index(self):
        r = self.evaluate()
        self.assertEqual(r['statusCounts'], {'checked': 9})
        self.assertFalse(r['requiresInvestigation'])
        self.assertIsNone(r['qualityVerdict'])
        self.assertEqual(checks(r)['occurrence-alignment']['boardStopSequence'], 30)
        self.assertEqual(checks(r)['boarding-time']['sourceSecs'], 87060)

    def test_calendar_removal_overrides_weekly_service(self):
        c = checks(self.evaluate(source(exceptions=[('20261113', '2')])))['service-eligibility']
        self.assertEqual((c['status'], c['active'], c['exceptionType']), ('finding', False, '2'))

    def test_calendar_addition_overrides_disabled_weekday(self):
        c = checks(self.evaluate(source(days='0', exceptions=[('20261113', '1')])))['service-eligibility']
        self.assertEqual((c['status'], c['active']), ('checked', True))

    def test_calendar_dates_only_and_unlisted_date(self):
        feed = source(calendar=False, exceptions=[('20261113', '1')])
        self.assertEqual(checks(self.evaluate(feed))['service-eligibility']['status'], 'checked')
        r = self.evaluate(feed, lambda d: d['cases'][0].update(serviceDate='20261114'))
        self.assertEqual(checks(r)['service-eligibility']['status'], 'finding')

    def test_outside_service_range_and_weekday_inactive(self):
        for feed, date in [(source(), '20261201'), (source(days='0'), '20261113')]:
            r = self.evaluate(feed, lambda d: d['cases'][0].update(serviceDate=date))
            self.assertEqual(checks(r)['service-eligibility']['status'], 'finding')

    def test_missing_trip_and_route_mismatch_are_findings(self):
        for field, value, check in [('tripId', 'missing', 'trip-identity'), ('routeId', 'wrong', 'route-identity')]:
            r = self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update({field: value}))
            self.assertEqual(checks(r)[check]['status'], 'finding')
            self.assertTrue(r['requiresInvestigation'])

    def test_corrupted_departure_and_arrival_are_independent_findings(self):
        for field, check in [('departSecs', 'boarding-time'), ('arriveSecs', 'alighting-time')]:
            r = self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update({field: 1}))
            self.assertEqual(checks(r)[check]['status'], 'finding')

    def test_first_occurrence_is_not_silently_substituted(self):
        r = self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update(boardStopIdx=0, departSecs=86400))
        self.assertEqual(checks(r)['pickup']['status'], 'finding')
        self.assertEqual(checks(r)['boarding-time']['status'], 'checked')

    def test_prohibited_alighting_and_conditional_boarding(self):
        r = self.evaluate(source(stop_changes={2: {'pickup_type': '2'}, 3: {'drop_off_type': '1'}}))
        self.assertEqual(checks(r)['pickup']['status'], 'not-evaluated')
        self.assertEqual(checks(r)['drop-off']['status'], 'finding')
        r = self.evaluate(source(stop_changes={2: {'pickup_type': '3'}}))
        self.assertEqual(checks(r)['pickup']['status'], 'not-evaluated')

    def test_missing_invalid_and_frequency_times_are_not_passes(self):
        r = self.evaluate(source(stop_changes={2: {'departure_time': ''}}))
        self.assertEqual(checks(r)['boarding-time']['status'], 'not-evaluated')
        r = self.evaluate(source(stop_changes={2: {'departure_time': '24:99:00'}}))
        self.assertEqual(checks(r)['boarding-time']['status'], 'source-invalid')
        r = self.evaluate(source(frequency=True))
        self.assertEqual(checks(r)['boarding-time']['status'], 'not-evaluated')
        self.assertEqual(checks(r)['alighting-time']['status'], 'not-evaluated')
        self.assertEqual(checks(r)['service-eligibility']['status'], 'not-evaluated')

    def test_unaligned_or_absent_snapshot_is_not_an_inferred_occurrence(self):
        for changes in [{'patternStopIds': None}, {'patternStopIds': ['origin', 'other', 'origin', 'destination']}]:
            r = self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update(changes))
            self.assertEqual(checks(r)['occurrence-alignment']['status'], 'not-evaluated')
            self.assertNotIn('boarding-time', checks(r))

    def test_invalid_candidate_occurrence_is_finding(self):
        r = self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update(boardStopIdx=True))
        self.assertEqual(checks(r)['occurrence-alignment']['status'], 'not-evaluated')
        r = self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update(boardStopIdx=3))
        self.assertEqual(checks(r)['occurrence-alignment']['status'], 'finding')

    def test_duplicate_source_occurrence_and_exception_are_rejected(self):
        for feed in [source(duplicate_sequence=True), source(exceptions=[('20261113', '1'), ('20261113', '2')])]:
            with self.assertRaises(ValueError):
                self.evaluate(feed)

    def test_hash_mismatch_and_invalid_service_date_rejected_before_source_read(self):
        feed = source()
        for edit in [lambda d: d.update(sourceGTFSsha256='0' * 64), lambda d: d['cases'][0].update(serviceDate='20260230')]:
            with self.assertRaises(ValueError):
                self.evaluate(feed, edit)

    def test_empty_and_walking_candidates_do_not_claim_feasibility(self):
        r = self.evaluate(edit=lambda d: d['cases'][0].update(candidates=[]))
        self.assertEqual(r['statusCounts'], {})
        self.assertIsNone(r['qualityVerdict'])
        r = self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0].update(legs=[{'type': 'walk'}]))
        self.assertEqual(r['statusCounts'], {'not-evaluated': 1})
        self.assertIn('full journey feasibility', r['unsupported'])

    def test_next_service_day_is_derived_from_published_times_not_query_date(self):
        feed = source(days='0', exceptions=[('20261114', '1')])
        def edit(d):
            leg = d['cases'][0]['candidates'][0]['legs'][0]
            leg.update(departSecs=87060 + 86400, arriveSecs=87600 + 86400)
        c = checks(self.evaluate(feed, edit))
        self.assertTrue(c['service-eligibility']['active'])
        self.assertEqual(c['service-day-alignment']['sourceServiceDate'], '20261114')
        self.assertEqual((c['service-eligibility']['serviceDate'], c['service-eligibility']['active']), ('20261114', True))
        self.assertEqual(c['boarding-time']['status'], 'checked')
        self.assertEqual(c['alighting-time']['status'], 'checked')

    def test_previous_service_day_above_24h_is_not_redated_by_wall_clock(self):
        feed = source(days='0', exceptions=[('20261113', '1')])
        def edit(d):
            d['cases'][0]['serviceDate'] = '20261114'
            d['cases'][0]['candidates'][0]['legs'][0].update(departSecs=660, arriveSecs=1200)
        c = checks(self.evaluate(feed, edit))
        self.assertTrue(c['service-eligibility']['active'])
        self.assertEqual(c['service-day-alignment']['sourceServiceDate'], '20261113')
        self.assertTrue(c['service-eligibility']['active'])
        self.assertEqual(c['boarding-time']['expectedTimelineSecs'], 660)
        # The unshifted 24h+ fixture belongs to the declared service date.
        self.assertEqual(checks(self.evaluate())['service-day-alignment']['sourceServiceDate'], '20261113')

    def test_both_dst_transitions_in_both_directions_use_elapsed_origin_difference(self):
        for before, after, elapsed in [('20260328', '20260329', 82800), ('20261024', '20261025', 90000)]:
            for query, source_date, shift in [(before, after, elapsed), (after, before, -elapsed)]:
                with self.subTest(query=query, source_date=source_date):
                    feed = source(days='0', exceptions=[(source_date, '1')])
                    def edit(d):
                        d['cases'][0]['serviceDate'] = query
                        d['cases'][0]['candidates'][0]['legs'][0].update(departSecs=87060 + shift, arriveSecs=87600 + shift)
                    c = checks(self.evaluate(feed, edit))
                    self.assertEqual(c['service-day-alignment']['sourceServiceDate'], source_date)
                    self.assertTrue(c['service-eligibility']['active'])
                    self.assertEqual(c['boarding-time']['status'], 'checked')
                    self.assertEqual(c['alighting-time']['status'], 'checked')
        zone, _ = t.load_zone('Europe/Vilnius')
        # On transition days the origin is not local midnight.
        self.assertEqual(t.datetime.fromtimestamp(t.origin('20260329', zone), t.timezone.utc).isoformat(), '2026-03-28T21:00:00+00:00')
        self.assertEqual(t.datetime.fromtimestamp(t.origin('20261025', zone), t.timezone.utc).isoformat(), '2026-10-24T22:00:00+00:00')

    def test_previous_service_day_over_24_hours_is_not_redated_to_event_civil_date(self):
        feed = source(days='0', exceptions=[('20261113', '1')])
        def edit(d):
            d['cases'][0]['serviceDate'] = '20261114'
            d['cases'][0]['candidates'][0]['legs'][0].update(departSecs=660, arriveSecs=1200)
        c = checks(self.evaluate(feed, edit))
        self.assertTrue(c['service-eligibility']['active'])
        self.assertEqual(c['service-day-alignment']['sourceServiceDate'], '20261113')
        self.assertEqual(c['boarding-time']['expectedTimelineSecs'], 660)
        self.assertEqual(c['alighting-time']['status'], 'checked')

    def test_cross_day_legs_use_23_and_25_hour_origin_intervals_in_both_directions(self):
        for query_date, source_date, delta in [('20260328', '20260329', 82800),
                                                ('20260329', '20260328', -82800),
                                                ('20261024', '20261025', 90000),
                                                ('20261025', '20261024', -90000)]:
            with self.subTest(query_date=query_date, source_date=source_date):
                feed = source(days='0', exceptions=[(source_date, '1')],
                              stop_changes={2: {'departure_time': '26:11:00'}, 3: {'arrival_time': '26:20:00'}})
                def edit(d):
                    d['cases'][0]['serviceDate'] = query_date
                    d['cases'][0]['candidates'][0]['legs'][0].update(departSecs=94260 + delta, arriveSecs=94800 + delta)
                c = checks(self.evaluate(feed, edit))
                self.assertTrue(c['service-eligibility']['active'])
                alignment = c['service-day-alignment']
                self.assertEqual(alignment['sourceServiceDate'], source_date)
                self.assertEqual(alignment['sourceTimeOriginUnix'] - alignment['queryTimeOriginUnix'], delta)
                self.assertEqual(c['boarding-time']['status'], 'checked')
                self.assertEqual(c['alighting-time']['status'], 'checked')

    def test_conflicting_endpoint_days_and_uniform_non_day_shift_are_not_normalized(self):
        for changes, reason in [({'arriveSecs': 87600 + 86400}, 'conflicting published endpoint service origins'),
                                ({'departSecs': 87120, 'arriveSecs': 87660}, 'no compatible published service origin')]:
            c = checks(self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update(changes)))
            self.assertEqual(c['service-day-alignment']['status'], 'finding')
            self.assertEqual(c['service-day-alignment']['reason'], reason)
            self.assertEqual(c['service-eligibility']['status'], 'not-evaluated')
            self.assertEqual(c['boarding-time']['status'], 'not-evaluated')

    def test_shift_to_inactive_source_day_remains_a_finding(self):
        def edit(d):
            d['cases'][0]['candidates'][0]['legs'][0].update(departSecs=87060 + 86400, arriveSecs=87600 + 86400)
        c = checks(self.evaluate(source(days='0', exceptions=[('20261113', '1')]), edit))
        self.assertEqual(c['boarding-time']['status'], 'checked')
        self.assertEqual(c['service-eligibility']['status'], 'finding')
        self.assertEqual(c['service-eligibility']['serviceDate'], '20261114')

    def test_missing_frame_cannot_silently_assume_single_day_times(self):
        r = self.evaluate(edit=lambda d: d.pop('timeFrame'))
        c = checks(r)
        for name in ['service-day-alignment', 'service-eligibility', 'boarding-time', 'alighting-time']:
            self.assertEqual(c[name]['status'], 'not-evaluated')
        self.assertEqual(c['pickup']['status'], 'checked')
        self.assertIsNone(r['timezoneRulesSha256'])

    def test_wrong_or_unavailable_frame_rejected_and_rules_fingerprinted(self):
        for frame in [{'kind': 'wall-clock', 'timezone': 'Europe/Vilnius'},
                      {'kind': 'gtfs-service-origin', 'timezone': 'UTC'}, {'kind': 'gtfs-service-origin'}]:
            with self.assertRaises(ValueError):
                self.evaluate(edit=lambda d: d.update(timeFrame=frame))
        for name in ['../not-a-zone', 'Unavailable/Timezone']:
            with self.assertRaises(ValueError):
                t.load_zone(name)
        r = self.evaluate()
        self.assertRegex(r['timezoneRulesSha256'], r'^[0-9a-f]{64}$')

    def test_missing_source_time_never_becomes_a_checked_time_from_other_endpoint(self):
        c = checks(self.evaluate(source(stop_changes={2: {'departure_time': ''}})))
        self.assertEqual(c['boarding-time']['status'], 'not-evaluated')
        self.assertEqual(c['service-day-alignment']['derivedFrom'], ['alighting-time'])
        self.assertEqual(c['alighting-time']['status'], 'checked')

    def test_single_digit_hours_and_large_invalid_projected_time(self):
        self.assertEqual(t.seconds('1:02:03'), 3723)
        for value in [True, 1e30, 10 ** 100]:
            c = checks(self.evaluate(edit=lambda d: d['cases'][0]['candidates'][0]['legs'][0].update(departSecs=value)))
            self.assertEqual(c['boarding-time']['status'], 'finding')

    def test_extension_after_alighting_preserves_exact_occurrences_without_searching(self):
        def edit(d):
            d['cases'][0]['candidates'][0]['legs'][0]['patternStopIds'].append('extra')
        c = checks(self.evaluate(edit=edit))
        self.assertEqual(c['occurrence-alignment']['status'], 'checked')
        self.assertFalse(c['occurrence-alignment']['fullPatternEqual'])
        self.assertEqual(c['occurrence-alignment']['sourcePatternLength'], 4)
        self.assertEqual(c['occurrence-alignment']['candidatePatternLength'], 5)
        self.assertEqual(c['boarding-time']['sourceSecs'], 87060)
        # A shifted prefix with the same two selected stop IDs cannot qualify.
        def wrong(d):
            leg = d['cases'][0]['candidates'][0]['legs'][0]
            leg.update(patternStopIds=['loop', 'origin', 'destination'], boardStopIdx=1, alightStopIdx=2)
        c = checks(self.evaluate(edit=wrong))
        self.assertEqual(c['occurrence-alignment']['status'], 'not-evaluated')
        self.assertNotIn('boarding-time', c)

    def test_source_suffix_after_alighting_does_not_change_checked_prefix(self):
        def edit(d):
            leg = d['cases'][0]['candidates'][0]['legs'][0]
            leg.update(boardStopIdx=0, alightStopIdx=2, toStopId='origin', departSecs=86400, arriveSecs=87000,
                       patternStopIds=['origin', 'loop', 'origin', 'different-suffix'])
        c = checks(self.evaluate(edit=edit))
        self.assertEqual(c['occurrence-alignment']['status'], 'checked')
        self.assertEqual(c['alighting-time']['status'], 'checked')
        self.assertFalse(c['occurrence-alignment']['fullPatternEqual'])
        self.assertEqual(c['pickup']['status'], 'finding')  # Exact first origin still prohibits boarding.

    def test_schema_digest_types_and_duplicate_case_ids_are_rejected(self):
        for edit in [lambda d: d.update(schemaVersion=True), lambda d: d.update(sourceGTFSsha256=None),
                     lambda d: d['cases'].append(d['cases'][0]), lambda d: d['cases'][0].update(candidates='invalid')]:
            with self.assertRaises(ValueError):
                self.evaluate(edit=edit)

    def test_cli_is_read_only_private_and_refuses_overwrite_even_with_findings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            feed = source()
            document = cases(feed)
            document['cases'][0]['candidates'][0]['legs'][0]['departSecs'] = 0
            (root / 'feed.zip').write_bytes(feed)
            (root / 'cases.json').write_text(json.dumps(document))
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            command = [sys.executable, str(HERE / 'timetable.py'), '--gtfs', str(root / 'feed.zip'), '--cases', str(root / 'cases.json'), '--out', str(root / 'report.json')]
            run = subprocess.run(command, capture_output=True)
            self.assertEqual(run.returncode, 2, run.stderr)
            output = root / 'report.json'
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            original = output.read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual({name: (root / name).read_bytes() for name in before}, before)
            link = root / 'linked-output.json'
            link.symlink_to(root / 'feed.zip')
            for target in [root / 'feed.zip', link]:
                self.assertNotEqual(subprocess.run(command[:-1] + [str(target)], capture_output=True).returncode, 0)
                self.assertEqual((root / 'feed.zip').read_bytes(), feed)


if __name__ == '__main__':
    unittest.main()
