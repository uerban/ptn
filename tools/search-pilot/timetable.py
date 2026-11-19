"""Offline source-timetable diagnostics, not a journey-feasibility oracle.

Rules: https://gtfs.org/documentation/schedule/reference/
No planner imports, downloads, feed extraction or input mutation.
"""
import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile
import zoneinfo
from importlib import resources

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_ZIP_BYTES = 64 * 1024 * 1024
MAX_TABLE_BYTES = 128 * 1024 * 1024
MAX_ROWS = 4_000_000
WEEKDAYS = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')
UNSUPPORTED = ['pedestrian reachability and pace', 'transfer rules and connection feasibility',
               'real-time composition', 'accessibility', 'candidate completeness or ranking',
               'full journey feasibility', 'source-to-compiled rebuild equivalence']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def service_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{8}', value):
        raise ValueError('serviceDate must be YYYYMMDD')
    return datetime.strptime(value, '%Y%m%d').date()


def seconds(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+:[0-5][0-9]:[0-5][0-9]', value):
        raise ValueError('missing or invalid published time')
    hour, minute, second = map(int, value.split(':'))
    return hour * 3600 + minute * 60 + second


def load_zone(name):
    """Use and fingerprint the same IANA rules, including system tzdata installs."""
    try:
        zoneinfo.ZoneInfo(name)  # Validates the key before constructing paths.
        data = next((Path(root, name).read_bytes() for root in zoneinfo.TZPATH
                     if Path(root, name).is_file()), None)
        if data is None:
            data = resources.files('tzdata.zoneinfo').joinpath(*name.split('/')).read_bytes()
        return zoneinfo.ZoneInfo.from_file(io.BytesIO(data), key=name), digest(data)
    except (ValueError, OSError, ImportError, TypeError, zoneinfo.ZoneInfoNotFoundError) as error:
        raise ValueError('unsupported or unavailable IANA timezone') from error


def origin(date, zone):
    """GTFS noon minus 12 *elapsed* hours, never local-midnight arithmetic."""
    day = service_date(date)
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=zone)
    if (noon.timestamp() != noon.replace(fold=1).timestamp()
            or datetime.fromtimestamp(noon.timestamp(), zone) != noon):
        raise ValueError('ambiguous or nonexistent local noon unsupported')
    return int(noon.timestamp()) - 43200


def origin_date(value, zone):
    try:
        noon = datetime.fromtimestamp(value + 43200, zone)
        date = f'{noon.year:04}{noon.month:02}{noon.day:02}'
        if (noon.hour, noon.minute, noon.second) == (12, 0, 0) and origin(date, zone) == value:
            return date
    except (ValueError, OverflowError, OSError):
        pass
    return None


def rows(archive, name, required, optional=False):
    members = [i for i in archive.infolist() if i.filename == name]
    if not members and optional:
        return
    if len(members) != 1 or members[0].file_size > MAX_TABLE_BYTES:
        raise ValueError(f'{name}: missing, duplicate or oversized table')
    with archive.open(members[0]) as stream, io.TextIOWrapper(stream, encoding='utf-8-sig', newline='') as text:
        reader = csv.DictReader(text)
        fields = reader.fieldnames or []
        if len(fields) != len(set(fields)) or not set(required).issubset(fields):
            raise ValueError(f'{name}: missing or duplicate columns')
        for index, row in enumerate(reader):
            if index >= MAX_ROWS or None in row or any(v is None for v in row.values()):
                raise ValueError(f'{name}: malformed or over-limit rows')
            yield row


def validate_cases(document):
    if not isinstance(document, dict) or type(document.get('schemaVersion')) is not int or document['schemaVersion'] != 1:
        raise ValueError('unsupported case schema')
    if not isinstance(document.get('sourceGTFSsha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', document['sourceGTFSsha256']):
        raise ValueError('sourceGTFSsha256 is required')
    frame = document.get('timeFrame')
    if frame is not None and (not isinstance(frame, dict) or frame.get('kind') != 'gtfs-service-origin'
                              or not isinstance(frame.get('timezone'), str)):
        raise ValueError('timeFrame must declare gtfs-service-origin and an IANA timezone')
    cases = document.get('cases')
    if not isinstance(cases, list) or not 1 <= len(cases) <= 50:
        raise ValueError('expected 1..50 cases')
    ids, trip_ids = set(), set()
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get('id'), str) or not case['id'] or case['id'] in ids:
            raise ValueError('case ids must be unique nonempty strings')
        ids.add(case['id'])
        service_date(case.get('serviceDate'))
        candidates = case.get('candidates')
        if not isinstance(candidates, list) or len(candidates) > 256:
            raise ValueError('expected at most 256 candidates per case')
        for candidate in candidates:
            if not isinstance(candidate, dict) or not isinstance(candidate.get('legs'), list) or not 1 <= len(candidate['legs']) <= 256:
                raise ValueError('expected 1..256 candidate legs')
            for leg in candidate['legs']:
                if not isinstance(leg, dict):
                    raise ValueError('leg must be an object')
                if leg.get('type') == 'transit':
                    if not isinstance(leg.get('tripId'), str) or not leg['tripId']:
                        raise ValueError('transit tripId is required')
                    trip_ids.add(leg['tripId'])
    if len(trip_ids) > 1024:
        raise ValueError('at most 1024 referenced trips supported')
    return cases, trip_ids


def load_source(data, trip_ids):
    trips, calendars, exceptions, stops, frequencies = {}, {}, {}, defaultdict(list), set()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = {i.filename for i in archive.infolist()}
        if not {'calendar.txt', 'calendar_dates.txt'} & names:
            raise ValueError('source needs calendar.txt or calendar_dates.txt')
        zones = {r['agency_timezone'] for r in rows(archive, 'agency.txt', ['agency_timezone'])}
        if len(zones) != 1 or not next(iter(zones)):
            raise ValueError('source requires one shared agency timezone')
        zone_name = next(iter(zones))
        for row in rows(archive, 'trips.txt', ['trip_id', 'route_id', 'service_id']):
            if row['trip_id'] in trip_ids:
                if row['trip_id'] in trips or not row['route_id'] or not row['service_id']:
                    raise ValueError('duplicate or invalid referenced trip')
                trips[row['trip_id']] = row
        service_ids = {r['service_id'] for r in trips.values()}
        for row in rows(archive, 'calendar.txt', ['service_id', 'start_date', 'end_date', *WEEKDAYS], True):
            if row['service_id'] in service_ids:
                if row['service_id'] in calendars or any(row[d] not in ('0', '1') for d in WEEKDAYS):
                    raise ValueError('duplicate or invalid referenced calendar')
                if service_date(row['start_date']) > service_date(row['end_date']):
                    raise ValueError('reversed service range')
                calendars[row['service_id']] = row
        for row in rows(archive, 'calendar_dates.txt', ['service_id', 'date', 'exception_type'], True):
            if row['service_id'] in service_ids:
                service_date(row['date'])
                key = row['service_id'], row['date']
                if key in exceptions or row['exception_type'] not in ('1', '2'):
                    raise ValueError('duplicate or invalid referenced calendar exception')
                exceptions[key] = row['exception_type']
        for row in rows(archive, 'stop_times.txt', ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time']):
            if row['trip_id'] in trip_ids:
                if not re.fullmatch(r'[0-9]+', row['stop_sequence']) or not row['stop_id']:
                    raise ValueError('invalid referenced stop occurrence')
                stops[row['trip_id']].append(row)
                if len(stops[row['trip_id']]) > 8192:
                    raise ValueError('referenced trip exceeds 8192 occurrences')
        for trip_rows in stops.values():
            trip_rows.sort(key=lambda r: int(r['stop_sequence']))
            if len({int(r['stop_sequence']) for r in trip_rows}) != len(trip_rows):
                raise ValueError('duplicate referenced stop sequence')
        for row in rows(archive, 'frequencies.txt', ['trip_id'], True):
            if row['trip_id'] in trip_ids:
                frequencies.add(row['trip_id'])
    return trips, calendars, exceptions, stops, frequencies, zone_name


def inspect_leg(leg, date, source, zone):
    trips, calendars, exceptions, stops, frequencies, _ = source
    checks = []

    def add(check, status, **details):
        checks.append({'check': check, 'status': status, **details})

    trip = trips.get(leg['tripId'])
    if not trip:
        add('trip-identity', 'finding', code='trip-not-in-source')
        return checks
    add('trip-identity', 'checked', tripId=leg['tripId'])
    add('route-identity', 'checked' if trip['route_id'] == leg.get('routeId') else 'finding', sourceRouteId=trip['route_id'])
    pattern, board, alight = leg.get('patternStopIds'), leg.get('boardStopIdx'), leg.get('alightStopIdx')
    if not isinstance(pattern, list) or type(board) is not int or type(alight) is not int:
        add('occurrence-alignment', 'not-evaluated', reason='explicit occurrence snapshot required')
        return checks
    if not (0 <= board < alight < len(pattern)) or pattern[board] != leg.get('fromStopId') or pattern[alight] != leg.get('toStopId'):
        add('occurrence-alignment', 'finding', code='invalid-candidate-occurrence')
        return checks
    times = stops.get(leg['tripId'], [])
    if not times:
        add('occurrence-alignment', 'source-invalid', reason='source trip has no stop times')
        return checks
    source_pattern = [r['stop_id'] for r in times]
    # Routing patterns can extend beyond this trip. Match every position from
    # its start through alighting, never search for a matching stop/subsequence.
    if source_pattern[:alight + 1] != pattern[:alight + 1]:
        add('occurrence-alignment', 'not-evaluated', reason='source and compiled prefixes through alighting differ')
        return checks
    add('occurrence-alignment', 'checked', boardStopSequence=int(times[board]['stop_sequence']),
        alightStopSequence=int(times[alight]['stop_sequence']), comparisonScope='complete prefix through alighting',
        fullPatternEqual=source_pattern == pattern, sourcePatternLength=len(source_pattern), candidatePatternLength=len(pattern))
    endpoints = [(board, 'departure_time', 'boarding-time', 'departSecs'),
                 (alight, 'arrival_time', 'alighting-time', 'arriveSecs')]
    published, inferred, failures = {}, {}, {}
    query_origin = origin(date, zone) if zone is not None else None
    for index, field, check, projected in endpoints:
        raw = times[index][field]
        if leg['tripId'] in frequencies:
            failures[check] = ('not-evaluated', 'frequency trip expansion unsupported')
        else:
            try:
                published[check] = seconds(raw)
            except ValueError:
                failures[check] = ('not-evaluated' if not raw else 'source-invalid', 'source time missing or invalid')
        if check in failures:
            continue
        if query_origin is None:
            failures[check] = ('not-evaluated', 'explicit query time frame required')
        elif type(leg.get(projected)) is not int:
            failures[check] = ('finding', 'candidate time must be integer seconds')
        else:
            possible_origin = query_origin + leg[projected] - published[check]
            possible_date = origin_date(possible_origin, zone)
            if possible_date is not None:
                inferred[check] = (possible_origin, possible_date)
    dates = set(inferred.values())
    selected = next(iter(dates)) if len(dates) == 1 else None
    if selected is not None:
        source_origin, source_date = selected
        add('service-day-alignment', 'checked', sourceServiceDate=source_date,
            queryTimeOriginUnix=query_origin, sourceTimeOriginUnix=source_origin,
            derivedFrom=sorted(inferred), basis='compatible published endpoint times; not engine-instance provenance')
        sid = trip['service_id']
        exception = exceptions.get((sid, source_date))
        calendar = calendars.get(sid)
        if exception:
            active = exception == '1'
        elif calendar:
            day = service_date(source_date)
            active = calendar['start_date'] <= source_date <= calendar['end_date'] and calendar[WEEKDAYS[day.weekday()]] == '1'
        elif any(s == sid for s, _ in exceptions):
            active = False
        else:
            active = None
        add('service-eligibility', 'source-invalid' if active is None else 'checked' if active else 'finding',
            serviceId=sid, serviceDate=source_date, active=active, exceptionType=exception)
    else:
        reason = ('conflicting published endpoint service origins' if dates else
                  'no compatible published service origin' if not failures else
                  'source service day could not be established')
        add('service-day-alignment', 'finding' if dates or not failures else 'not-evaluated', reason=reason)
        add('service-eligibility', 'not-evaluated', reason='source service day not established')
    for index, field, check, projected in endpoints:
        if check in failures:
            status, reason = failures[check]
            add(check, status, reason=reason)
        elif selected is None:
            add(check, 'not-evaluated', reason='source service day not established')
        else:
            expected = published[check] + selected[0] - query_origin
            add(check, 'checked' if leg[projected] == expected else 'finding',
                sourceSecs=published[check], expectedTimelineSecs=expected, candidateSecs=leg[projected],
                timepoint=times[index].get('timepoint', ''))
    for index, field, check in [(board, 'pickup_type', 'pickup'), (alight, 'drop_off_type', 'drop-off')]:
        row = times[index]
        value = row.get(field, '') or '0'
        if row.get('start_pickup_drop_off_window') or row.get('end_pickup_drop_off_window') or row.get('location_id') or row.get('location_group_id'):
            add(check, 'not-evaluated', reason='flexible service unsupported')
        elif value == '1':
            add(check, 'finding', sourceValue=value, code='boarding-prohibited' if field == 'pickup_type' else 'alighting-prohibited')
        elif value in ('2', '3'):
            add(check, 'not-evaluated', sourceValue=value, reason='conditional service arrangement unknown')
        elif value == '0':
            add(check, 'checked', sourceValue=value)
        else:
            add(check, 'source-invalid', sourceValue=value)
    return checks


def build_report(gtfs, document):
    cases, trip_ids = validate_cases(document)
    if len(gtfs) > MAX_ZIP_BYTES or digest(gtfs) != document['sourceGTFSsha256']:
        raise ValueError('source GTFS size or digest mismatch')
    source = load_source(gtfs, trip_ids)
    frame = document.get('timeFrame')
    zone, rules_sha = None, None
    if frame is not None:
        if frame['timezone'] != source[-1]:
            raise ValueError('declared time frame differs from source agency timezone')
        zone, rules_sha = load_zone(frame['timezone'])
    results, counts = [], Counter()
    for case in cases:
        candidates = []
        for index, candidate in enumerate(case['candidates']):
            legs = []
            for leg_index, leg in enumerate(candidate['legs']):
                checks = inspect_leg(leg, case['serviceDate'], source, zone) if leg.get('type') == 'transit' else [
                    {'check': 'leg-type', 'status': 'not-evaluated', 'reason': 'only transit source timetable checked'}]
                counts.update(c['status'] for c in checks)
                legs.append({'legIndex': leg_index, 'checks': checks})
            candidates.append({'candidateIndex': index, 'legs': legs})
        results.append({'id': case['id'], 'serviceDate': case['serviceDate'], 'candidates': candidates})
    return {'schemaVersion': 1, 'kind': 'ptn-source-timetable-diagnostics', 'sourceGTFSsha256': digest(gtfs),
            'scope': 'compatibility with published source timetable in declared query frame; no engine-instance or compiled-feed equivalence proof',
            'timeFrame': frame, 'timezoneRulesSha256': rules_sha,
            'statusCounts': dict(sorted(counts.items())), 'requiresInvestigation': bool(counts['finding'] or counts['source-invalid']),
            'qualityVerdict': None, 'unsupported': UNSUPPORTED, 'cases': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gtfs', required=True, type=Path)
    parser.add_argument('--cases', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    if args.gtfs.stat().st_size > MAX_ZIP_BYTES or args.cases.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError('input size limit exceeded')
    case_bytes = args.cases.read_bytes()
    if len(case_bytes) > MAX_INPUT_BYTES:
        raise ValueError('case input size limit exceeded')
    report = build_report(args.gtfs.read_bytes(), json.loads(case_bytes))
    report['casesSha256'] = digest(case_bytes)
    encoded = (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(encoded)
    return 2 if report['requiresInvestigation'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
