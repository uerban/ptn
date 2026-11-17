"""Read-only, evidence-checked report for a retained local pilot."""
import argparse
from collections import Counter, defaultdict
import json
import math
import os
from pathlib import Path
import sqlite3

import ledger as ledger_contract
import runner as capture_inspector
from ledger import canonical, fingerprint, validate_plan
from runner import artifact, capture_result, now_ms, sha, storage_bytes


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def inspect_candidate(candidate, query):
    """Diagnostics on projected fields only; no timetable or pedestrian oracle."""
    findings, unchecked = [], []
    legs = candidate.get('legs') if isinstance(candidate, dict) else None
    if not isinstance(legs, list) or not legs:
        return {'status': 'not-evaluated', 'findings': [], 'unchecked': ['no projected leg chain']}
    previous = None
    for index, leg in enumerate(legs):
        if not isinstance(leg, dict):
            findings.append({'leg': index, 'code': 'invalid-leg'})
            continue
        depart, arrive = leg.get('departSecs'), leg.get('arriveSecs')
        if not finite(depart) or not finite(arrive):
            findings.append({'leg': index, 'code': 'missing-or-nonfinite-time'})
        elif arrive < depart:
            findings.append({'leg': index, 'code': 'arrival-before-departure'})
        if previous:
            if finite(previous.get('arriveSecs')) and finite(depart) and depart < previous['arriveSecs']:
                findings.append({'leg': index, 'code': 'overlapping-leg-chain'})
            if previous.get('toStopId') != leg.get('fromStopId'):
                findings.append({'leg': index, 'code': 'stop-discontinuity-requires-review'})
        if leg.get('type') == 'transit':
            pattern, board, alight = leg.get('patternStopIds'), leg.get('boardStopIdx'), leg.get('alightStopIdx')
            if isinstance(pattern, list):
                if (type(board) is not int or type(alight) is not int or not 0 <= board < alight < len(pattern)
                        or pattern[board] != leg.get('fromStopId') or pattern[alight] != leg.get('toStopId')):
                    findings.append({'leg': index, 'code': 'occurrence-snapshot-mismatch'})
            else:
                unchecked.append(f'leg {index}: occurrence snapshot absent')
            if 'approximate' in leg and type(leg['approximate']) is not bool:
                findings.append({'leg': index, 'code': 'invalid-headway-uncertainty-flag'})
        elif leg.get('type') != 'walk':
            unchecked.append(f'leg {index}: unsupported leg type')
        previous = leg
    first = legs[0]
    access = next((stop.get('walkSecs') for stop in query.get('entryStops', [])
                   if isinstance(stop, dict) and isinstance(first, dict) and stop.get('stopId') == first.get('fromStopId')), None)
    if finite(access) and finite(query.get('departureSecs')) and isinstance(first, dict) and finite(first.get('departSecs')):
        if query['departureSecs'] + access > first['departSecs']:
            findings.append({'leg': 0, 'code': 'access-arrives-after-first-departure'})
    else:
        unchecked.append('entry access mapping unavailable')
    return {'status': 'findings' if findings else 'no-findings-in-checked-fields', 'findings': findings, 'unchecked': unchecked}


def read_ledger(root):
    db = sqlite3.connect((root / 'pilot.sqlite').as_uri() + '?mode=ro', uri=True, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute('BEGIN')
        manifest = dict(db.execute('SELECT * FROM manifest WHERE id=1').fetchone())
        jobs = [dict(row) for row in db.execute('SELECT * FROM jobs ORDER BY ordinal')]
        attempts = [dict(row) for row in db.execute('''SELECT a.*,r.completion,r.data AS result
            FROM attempts a LEFT JOIN results r USING(token) ORDER BY a.started_ms,a.job_id,a.number''')]
        db.execute('COMMIT')
        return manifest, jobs, attempts
    finally:
        db.close()


def build_report(root, observed_at_ms=None):
    root = Path(root).resolve()
    manifest, jobs, records = read_ledger(root)
    plan = validate_plan(json.loads(manifest['data']))
    if fingerprint(plan) != manifest['digest']:
        raise ValueError('Pilot manifest integrity mismatch')
    expected_jobs = [{'id': fingerprint({'artifacts': plan['artifacts'], 'settings': plan['settings'], 'query': job['query']}),
                      'ordinal': index, 'data': canonical(job)} for index, job in enumerate(plan['jobs'])]
    if jobs != expected_jobs:
        raise ValueError('Pilot job table does not match the immutable manifest')
    observed = now_ms() if observed_at_ms is None else observed_at_ms
    snapshot_issues = []
    for name, digest in plan['artifacts'].items():
        try:
            artifact(root, digest)
        except (OSError, ValueError) as error:
            snapshot_issues.append({'artifact': name, 'error': str(error)})
    by_job = defaultdict(list)
    attempt_counts, elapsed, unknown_elapsed = Counter(), [], 0
    for record in records:
        job = json.loads(next(job['data'] for job in jobs if job['id'] == record['job_id']))
        completion = record['completion']
        attempt_counts[completion or 'pending'] += 1
        issues, captured, diagnostics = [], None, []
        try:
            evidence = json.loads(record['result']) if record['result'] else None
            if evidence is not None and not isinstance(evidence, dict):
                raise ValueError('result evidence is not an object')
        except ValueError as error:
            issues.append(f'invalid result evidence: {error}')
            evidence = None
        if evidence and evidence.get('completion') != completion:
            issues.append('ledger result completion mismatch')
        duration = evidence.get('elapsedMs') if evidence else None
        if duration is not None and (not finite(duration) or duration < 0):
            issues.append('invalid elapsed time')
        if finite(duration) and duration >= 0:
            elapsed.append(duration)
        else:
            unknown_elapsed += 1
        if evidence:
            if evidence.get('captureRunId') not in (None, record['token']):
                issues.append('capture reference does not match attempt')
            for name in ('stdout', 'stderr'):
                expected = evidence.get(f'{name}Sha256')
                if expected:
                    try:
                        if sha((root / 'attempts' / record['token'] / f'{name}.bin').read_bytes()) != expected:
                            issues.append(f'{name} digest mismatch')
                    except OSError as error:
                        issues.append(f'{name} unavailable: {error}')
        try:
            captured = capture_result(root, plan, record['token'], job['query'])
            if captured and evidence and evidence.get('captureManifestSha256'):
                if captured['captureManifestSha256'] != evidence['captureManifestSha256']:
                    issues.append('capture manifest digest mismatch')
            if completion == 'success':
                if not captured or captured['completion'] != 'success' or not (evidence or {}).get('captureManifestSha256'):
                    issues.append('declared success has no verified immutable capture reference')
                elif type(evidence.get('candidateCount')) is not int or evidence['candidateCount'] != captured['candidateCount']:
                    issues.append('declared candidate count differs from capture')
                else:
                    capture_bytes = (root / 'runs' / f"{record['token']}.json").read_bytes()
                    if sha(capture_bytes) != captured['captureManifestSha256']:
                        issues.append('capture changed during report inspection')
                    capture = json.loads(capture_bytes)
                    tuple_ = capture['report']['tuples'][0]
                    if tuple_.get('capture') != {'equivalence': 'exact', 'truncated': False, 'boundary': 'stop-level engine'}:
                        issues.append('unsupported or incomplete candidate capture contract')
                    if not isinstance(tuple_.get('candidates'), list):
                        issues.append('captured candidates are not an array')
                    else:
                        diagnostics = [inspect_candidate(candidate, job['query']) for candidate in tuple_['candidates']]
        except (ValueError, OSError, KeyError, TypeError, IndexError, AttributeError) as error:
            issues.append(f'capture inspection: {error}')
        verified = completion == 'success' and captured is not None and not issues and not snapshot_issues
        state = completion or ('expired-pending' if record['expires_ms'] <= observed else 'pending')
        by_job[record['job_id']].append({'token': record['token'], 'number': record['number'], 'state': state,
            'verifiedCapture': verified, 'candidateCount': captured['candidateCount'] if verified else None,
            'recoveryCaptureAvailable': completion is None and captured is not None,
            'lateCaptureAvailable': completion == 'abandoned' and captured is not None,
            'elapsedMs': duration if finite(duration) and duration >= 0 else None,
            'evidenceIssues': issues, 'candidateDiagnostics': diagnostics,
            'captureManifestSha256': captured['captureManifestSha256'] if captured else None})
    job_rows, coverage = [], defaultdict(lambda: Counter())
    for job_record in jobs:
        job = json.loads(job_record['data'])
        attempts = by_job[job_record['id']]
        success = next((attempt for attempt in attempts if attempt['verifiedCapture']), None)
        if success:
            status = 'verified-empty' if success['candidateCount'] == 0 else 'verified-candidates'
        elif any(attempt['state'] in ('pending', 'expired-pending') for attempt in attempts):
            status = 'pending'
        elif any(attempt['state'] == 'success' for attempt in attempts):
            status = 'evidence-invalid'
        elif len(attempts) >= plan['limits']['maxAttemptsPerJob']:
            status = 'attempts-exhausted'
        else:
            status = 'retryable' if attempts else 'not-started'
        for dimension, value in [('partition', job['partition']), ('stratum', job['stratum']),
                                 ('serviceDate', job['query'].get('date', 'unspecified')),
                                 ('mobility', job['query'].get('mobilityProfile', 'default'))]:
            coverage[(dimension, str(value))][status] += 1
        job_rows.append({'jobId': job_record['id'], 'ordinal': job_record['ordinal'], 'partition': job['partition'],
                         'stratum': job['stratum'], 'status': status, 'attempts': attempts})
    statuses = Counter(job['status'] for job in job_rows)
    findings = [diagnostic for job in job_rows for attempt in job['attempts'] if attempt['verifiedCapture']
                for diagnostic in attempt['candidateDiagnostics']]
    integrity = not snapshot_issues and not any(attempt['evidenceIssues'] for job in job_rows for attempt in job['attempts'])
    return {'format': 'ptn-search-pilot-report', 'version': 1, 'observedAtMs': observed,
        'sourceDigests': {'reporter': sha(Path(__file__).read_bytes()),
                          'captureInspector': sha(Path(capture_inspector.__file__).read_bytes()),
                          'ledgerContract': sha(Path(ledger_contract.__file__).read_bytes())},
        'manifestSha256': manifest['digest'], 'ledgerViewSha256': fingerprint({'manifest': manifest, 'jobs': jobs, 'attempts': records}),
        'scope': plan.get('scope', 'declared ledger only'), 'classification': plan.get('classification', 'unverified'),
        'readOnly': True, 'filesystemScanAtomic': False,
        'reproducibilityUnsupported': plan.get('unsupported', ['retained execution scope not declared']),
        'networkIsolation': 'not established by this report',
        'evidenceIntegrity': 'no-issues-detected' if integrity else 'issues-detected', 'snapshotIssues': snapshot_issues,
        'executionStatus': 'all-jobs-have-verified-captures' if sum(statuses[key] for key in ('verified-empty', 'verified-candidates')) == len(jobs)
            else 'settled-with-failures' if all(job['status'] == 'attempts-exhausted' or job['status'].startswith('verified-') for job in job_rows)
            else 'incomplete',
        'jobCounts': dict(statuses), 'attemptCounts': dict(attempt_counts),
        'cost': {'knownAttemptElapsedMsTotal': round(sum(elapsed), 3), 'attemptsWithUnknownElapsed': unknown_elapsed,
                 'executionReservationMs': sum(record['reservation_ms'] for record in records),
                 'retainedBytesBeforeReportExport': storage_bytes(root), 'limits': plan['limits'],
                 'excludes': ['initialization and verification overhead', 'operator wait time', 'unknown interrupted attempt time']},
        'coverage': [{'dimension': dimension, 'value': value, 'jobCounts': dict(counts)} for (dimension, value), counts in sorted(coverage.items())],
        'samplingRepresentativeness': 'not established; manifest partitions and strata are declarations',
        'candidateDiagnostics': {'version': 1, 'candidatesInspected': len(findings),
            'candidatesWithFindings': sum(bool(item['findings']) for item in findings),
            'candidatesNotEvaluated': sum(item['status'] == 'not-evaluated' for item in findings),
            'checked': ['projected leg chronology', 'projected stop continuity', 'entry boarding when mapped', 'occurrence snapshots when present'],
            'unsupported': ['service eligibility', 'transfer rules', 'physical pedestrian reachability or pace', 'RT composition', 'full independent feasibility']},
        'requiresInvestigation': not integrity or any(item['findings'] for item in findings)
            or any(attempt['state'] in ('error', 'timeout', 'abandoned', 'expired-pending') for job in job_rows for attempt in job['attempts']),
        'reviewYield': {'status': 'not-evaluated', 'reason': 'no review actions supplied'}, 'qualityVerdict': None, 'jobs': job_rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pilot', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = build_report(args.pilot)
    fd = os.open(args.out, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        output.write(canonical(report) + '\n')
    print(canonical({'report': str(args.out), 'executionStatus': report['executionStatus'], 'jobCounts': report['jobCounts']}))


if __name__ == '__main__':
    main()
