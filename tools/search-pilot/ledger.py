"""Local pilot coordination. This module does not execute a planner or verify artifacts."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def validate_plan(plan):
    if not isinstance(plan, dict) or plan.get('format') != 'ptn-search-pilot' or plan.get('version') != 1:
        raise ValueError('Unsupported pilot manifest')
    if not isinstance(plan.get('seed'), str) or not plan['seed'].strip():
        raise ValueError('A materialized corpus seed is required')
    if not isinstance(plan.get('timezone'), str) or not plan['timezone'].strip():
        raise ValueError('A declared feed timezone is required')
    artifacts = plan.get('artifacts', {})
    if not isinstance(artifacts, dict) or not all(name in artifacts for name in ('ptb', 'glue', 'wasm')) or not all(
            isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) for value in artifacts.values()):
        raise ValueError('Pinned engine artifact hashes are required')
    if not isinstance(plan.get('settings'), dict):
        raise ValueError('Planning settings are required')
    limits = plan.get('limits', {})
    if not isinstance(limits, dict):
        raise ValueError('Pilot limits must be an object')
    for field, maximum in [('maxJobs', 50), ('maxAttemptsPerJob', 3),
                           ('attemptTimeoutMs', 300000), ('totalExecutionMs', 3600000),
                           ('maxStorageBytes', 1024 * 1024 * 1024)]:
        if type(limits.get(field)) is not int or not 1 <= limits[field] <= maximum:
            raise ValueError(f'Invalid pilot limit: {field}')
    if 'retryBackoffMs' in limits and (type(limits['retryBackoffMs']) is not int or not 0 <= limits['retryBackoffMs'] <= 60000):
        raise ValueError('Invalid pilot limit: retryBackoffMs')
    jobs = plan.get('jobs')
    if not isinstance(jobs, list) or not jobs or len(jobs) > limits['maxJobs']:
        raise ValueError('Empty corpus or job budget exceeded')
    ids = set()
    for job in jobs:
        if not isinstance(job, dict) or not isinstance(job.get('query'), dict) or not isinstance(job.get('stratum'), str) or not job['stratum'].strip():
            raise ValueError('Each job requires a query and declared stratum')
        if job.get('partition') not in ('reported', 'random', 'holdout', 'synthetic'):
            raise ValueError('Unknown sampling partition')
        identity = fingerprint({'artifacts': artifacts, 'settings': plan['settings'], 'query': job['query']})
        if identity in ids:
            raise ValueError('Duplicate query/build job; keep one job with explicit sampling context')
        ids.add(identity)
    canonical(plan)
    return plan


def retry_not_before(attempt, evidence, limits):
    """Optional v1 field: absent/zero preserves original ledger semantics."""
    base = limits.get('retryBackoffMs', 0)
    if not base or not evidence or evidence.get('completion') == 'success':
        return None
    delay = min(60000, base * 2 ** min(16, max(0, attempt['number'] - 1)))
    anchor = evidence.get('recordedAtMs', evidence.get('observedAtMs', attempt['expires_ms']))
    if type(anchor) is not int or anchor < 0:
        anchor = attempt['expires_ms']
    return anchor + delay


def create_ledger(path, plan):
    validate_plan(plan)
    # Refuse to initialize over any existing file, including an old pilot.
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    connection = sqlite3.connect(path)
    try:
        connection.execute('PRAGMA foreign_keys=ON')
        connection.executescript('''
            CREATE TABLE manifest (id INTEGER PRIMARY KEY CHECK(id=1), digest TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE jobs (id TEXT PRIMARY KEY, ordinal INTEGER UNIQUE NOT NULL, data TEXT NOT NULL);
            CREATE TABLE attempts (token TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
                number INTEGER NOT NULL, started_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
                reservation_ms INTEGER NOT NULL, UNIQUE(job_id,number));
            CREATE TABLE results (token TEXT PRIMARY KEY REFERENCES attempts(token),
                completion TEXT NOT NULL CHECK(completion IN ('success','error','timeout','abandoned','cancelled')),
                data TEXT NOT NULL);
            CREATE TABLE worker_lease (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL,
                owner TEXT NOT NULL, expires_ms INTEGER NOT NULL);
        ''')
        connection.execute('INSERT INTO manifest VALUES (1,?,?)', (fingerprint(plan), canonical(plan)))
        for ordinal, job in enumerate(plan['jobs']):
            identity = fingerprint({'artifacts': plan['artifacts'], 'settings': plan['settings'], 'query': job['query']})
            connection.execute('INSERT INTO jobs VALUES (?,?,?)', (identity, ordinal, canonical(job)))
        for table in ('manifest', 'jobs', 'attempts', 'results'):
            for operation in ('UPDATE', 'DELETE'):
                connection.execute(f'''CREATE TRIGGER immutable_{table}_{operation.lower()}
                    BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT,'immutable pilot evidence'); END''')
        connection.commit()
    finally:
        connection.close()


class Ledger:
    def __init__(self, path):
        self.db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True, isolation_level=None, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        row = self.db.execute('SELECT digest,data FROM manifest WHERE id=1').fetchone()
        self.plan = validate_plan(json.loads(row['data']))
        if row['digest'] != fingerprint(self.plan):
            raise ValueError('Pilot manifest integrity mismatch')

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def acquire(self, owner, now_ms, lease_ms):
        if not isinstance(owner, str) or not owner.strip() or type(lease_ms) is not int or lease_ms <= 0:
            raise ValueError('Owner and positive lease duration required')
        with self.transaction():
            previous = self.db.execute('SELECT * FROM worker_lease WHERE id=1').fetchone()
            if previous and previous['expires_ms'] > now_ms:
                return None
            token = uuid.uuid4().hex
            self.db.execute('INSERT OR REPLACE INTO worker_lease VALUES (1,?,?,?)', (token, owner, now_ms + lease_ms))
            return token

    def renew(self, token, now_ms, lease_ms):
        if type(lease_ms) is not int or lease_ms <= 0:
            raise ValueError('Positive lease duration required')
        return self.db.execute('UPDATE worker_lease SET expires_ms=? WHERE id=1 AND token=? AND expires_ms>?',
                               (now_ms + lease_ms, token, now_ms)).rowcount == 1

    def release(self, token):
        return self.db.execute('DELETE FROM worker_lease WHERE id=1 AND token=?', (token,)).rowcount == 1

    def claim(self, worker_token, now_ms, grace_ms=2000, admission_state=None):
        if type(grace_ms) is not int or grace_ms < 0:
            raise ValueError('Invalid finalization grace')
        if admission_state not in (None, 'storage-budget-exhausted'):
            raise ValueError('Unsupported admission state')
        limits = self.plan['limits']
        with self.transaction():
            lease = self.db.execute('SELECT * FROM worker_lease WHERE id=1 AND token=? AND expires_ms>?',
                                    (worker_token, now_ms)).fetchone()
            if not lease:
                raise ValueError('Worker lease expired or superseded')
            pending = self.db.execute('SELECT a.* FROM attempts a LEFT JOIN results r USING(token) WHERE r.token IS NULL').fetchall()
            # A previous worker may have died while its bounded child remains
            # alive. Never start another query before that child's deadline.
            if any(attempt['expires_ms'] > now_ms for attempt in pending):
                return {'state': 'waiting-for-attempt'}
            for attempt in pending:
                self.db.execute('INSERT INTO results VALUES (?,?,?)', (attempt['token'], 'abandoned', canonical({
                    'completion': 'abandoned', 'reason': 'attempt lease expired without a recorded ledger result', 'observedAtMs': now_ms})))
            reserved = self.db.execute('SELECT COALESCE(SUM(reservation_ms),0) FROM attempts').fetchone()[0]
            deferred = []
            for job in self.db.execute('SELECT * FROM jobs ORDER BY ordinal').fetchall():
                success = self.db.execute("SELECT 1 FROM attempts a JOIN results r USING(token) WHERE a.job_id=? AND r.completion='success'", (job['id'],)).fetchone()
                count = self.db.execute('SELECT COUNT(*) FROM attempts WHERE job_id=?', (job['id'],)).fetchone()[0]
                if success or count >= limits['maxAttemptsPerJob']:
                    continue
                if count:
                    last = self.db.execute('''SELECT a.*,r.data FROM attempts a JOIN results r USING(token)
                        WHERE a.job_id=? ORDER BY a.number DESC LIMIT 1''', (job['id'],)).fetchone()
                    ready = retry_not_before(last, json.loads(last['data']), limits)
                    if ready is not None and ready > now_ms:
                        deferred.append(ready)
                        continue
                if admission_state:
                    return {'state': admission_state}
                reservation = limits['attemptTimeoutMs'] + grace_ms
                if reserved + reservation > limits['totalExecutionMs']:
                    return {'state': 'execution-budget-exhausted'}
                token = uuid.uuid4().hex
                self.db.execute('INSERT INTO attempts VALUES (?,?,?,?,?,?)',
                                (token, job['id'], count + 1, now_ms, now_ms + reservation, reservation))
                return {'state': 'claimed', 'token': token, 'jobId': job['id'], 'attempt': count + 1,
                        'expiresAtMs': now_ms + reservation, 'job': json.loads(job['data'])}
            if deferred:
                return {'state': 'retry-backoff', 'retryAtMs': min(deferred), 'retryAfterMs': min(deferred) - now_ms}
            return {'state': 'finished'}

    def complete(self, attempt_token, completion, evidence, recorded_at_ms=None):
        if completion not in ('success', 'error', 'timeout', 'cancelled'):
            raise ValueError('Unknown attempt completion')
        if not isinstance(evidence, dict) or evidence.get('completion') != completion:
            raise ValueError('Evidence completion must match its recorded outcome')
        # The runner must provide capture references. The ledger preserves
        # their declared status; it does not certify engine equivalence.
        recorded = time.time_ns() // 1000000 if recorded_at_ms is None else recorded_at_ms
        if type(recorded) is not int or recorded < 0:
            raise ValueError('Invalid ledger recording time')
        self.db.execute('INSERT INTO results VALUES (?,?,?)',
                        (attempt_token, completion, canonical({**evidence, 'recordedAtMs': recorded})))

    def records(self):
        return [dict(row) for row in self.db.execute('''SELECT a.*,r.completion,r.data AS result
            FROM attempts a LEFT JOIN results r USING(token) ORDER BY a.started_ms,a.job_id,a.number''')]
