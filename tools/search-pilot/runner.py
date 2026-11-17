"""Opt-in POSIX local pilot using the existing supervised engine capture runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import subprocess
import sys
import time

from ledger import Ledger, canonical, create_ledger, validate_plan

RUNNER_FILES = ('temporal_baseline.mjs', 'baseline_store.mjs', 'baseline_candidates.mjs',
                'baseline_glue.mjs', 'baseline_supervisor.mjs')
HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / 'crates/pt-wasm/tests'
GRACE_MS = 2000
LEASE_MS = 3000


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now_ms():
    return time.time_ns() // 1000000


def artifact(store, digest):
    if not isinstance(digest, str) or len(digest) != 64 or any(char not in '0123456789abcdef' for char in digest):
        raise ValueError('Invalid artifact digest')
    data = (Path(store) / 'artifacts' / digest).read_bytes()
    if sha(data) != digest:
        raise ValueError(f'Artifact integrity mismatch: {digest}')
    return data


def storage_bytes(root):
    return sum(path.stat().st_size for path in Path(root).rglob('*') if path.is_file())


def node_environment():
    return {key: value for key, value in os.environ.items() if key not in ('NODE_OPTIONS', 'NODE_PATH', 'PT_BASELINE_SUPERVISED')}


def runtime(node):
    path = Path(shutil.which(node) or node).resolve(strict=True)
    return {'nodeSha256': sha(path.read_bytes()), 'nodeVersion': subprocess.check_output([str(path), '--version'], text=True, env=node_environment()).strip(),
            'platform': sys.platform, 'arch': platform.machine(), 'release': platform.release(),
            'pythonVersion': platform.python_version(), 'driverSha256': sha(Path(__file__).read_bytes()),
            'ledgerSha256': sha((HERE / 'ledger.py').read_bytes())}, path


def settings_check(plan):
    if plan['settings'] != {'objective': 'plan', 'patternMode': 'covering-merge', 'glueExecution': 'snapshot', 'iterations': 2, 'warmup': 0}:
        raise ValueError('Pilot initially supports exact repeated plan captures with snapshot glue only')
    if 'retryBackoffMs' in plan['limits'] and plan['limits']['retryBackoffMs'] < 1:
        raise ValueError('New runner pilots require a positive retryBackoffMs')
    size = plan['limits'].get('attemptFileBytes')
    if type(size) is not int or not 65536 <= size <= 16 * 1024 * 1024:
        raise ValueError('attemptFileBytes must be between 64 KiB and 16 MiB')


def initialize(root, source_store, source_run_id, plan, node='node'):
    validate_plan(plan)
    settings_check(plan)
    if not source_run_id or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in source_run_id):
        raise ValueError('Invalid source run ID')
    manifest_bytes = (Path(source_store) / 'runs' / f'{source_run_id}.json').read_bytes()
    source = json.loads(manifest_bytes)
    if source.get('schemaVersion') != 1 or source.get('completion') != 'success':
        raise ValueError('Source capture must have completed successfully')
    for name, digest in plan['artifacts'].items():
        if source['artifacts'].get(name) != digest:
            raise ValueError(f'Plan does not match retained source artifact: {name}')
    # Read/hash before creating a destination; source path changes cannot alter
    # the observed bytes subsequently retained here.
    values = {name: artifact(source_store, digest) for name, digest in source['artifacts'].items()}
    values['sourceRunManifest'] = manifest_bytes
    for name in RUNNER_FILES:
        values[f'runner:{name}'] = (SOURCE / name).read_bytes()
    execution, _ = runtime(node)
    frozen = json.loads(canonical(plan))
    frozen['limits'].setdefault('retryBackoffMs', 1000)
    frozen['artifacts'] = {name: sha(data) for name, data in values.items()}
    frozen['execution'] = execution
    spec = json.loads(values['producerRebuildSpec']) if 'producerRebuildSpec' in values else None
    if spec and spec.get('timezone') != frozen['timezone']:
        raise ValueError('Plan timezone differs from retained producer specification')
    frozen['timezoneEvidence'] = 'retained producer specification' if spec else 'caller declaration only'
    frozen['scope'] = 'stop-level compiled engine'
    frozen['classification'] = 'partial capture'
    frozen['unsupported'] = ['frontend geometry and RT', 'producer rebuild', 'Node binary/shared-library retention',
                             'external glue dependencies and detached subprocesses', 'filesystem-wide quota for arbitrary engine code']
    root = Path(root)
    # Account for retained blobs and the separate execution copies, plus DB
    # headroom. Runtime output admission is checked separately before each job.
    initial = sum(len(data) for data in {sha(value): value for value in values.values()}.values())
    initial += sum(len(values[name]) for name in ('ptb', 'glue', 'wasm'))
    initial += sum(len(values[f'runner:{name}']) for name in RUNNER_FILES) + 1024 * 1024
    if initial > frozen['limits']['maxStorageBytes']:
        raise ValueError('Initial retained snapshot exceeds storage admission budget')
    root.mkdir(mode=0o700)  # Private snapshot root; never overwrite old evidence.
    (root / 'artifacts').mkdir()
    for name, data in values.items():
        path = root / 'artifacts' / frozen['artifacts'][name]
        if not path.exists():
            with path.open('xb') as output:
                output.write(data)
    create_ledger(root / 'pilot.sqlite', frozen)
    return frozen


def materialize(root, plan):
    values = {name: artifact(root, digest) for name, digest in plan['artifacts'].items()}
    for directory, names in [('engine', {'bundle.ptb': 'ptb', 'pt_wasm.mjs': 'glue', 'pt_wasm_bg.wasm': 'wasm'}),
                              ('runner', {name: f'runner:{name}' for name in RUNNER_FILES})]:
        folder = root / directory
        folder.mkdir(exist_ok=True)
        for filename, name in names.items():
            path = folder / filename
            if path.exists():
                if path.read_bytes() != values[name]:
                    raise ValueError(f'Materialized input changed: {filename}')
            else:
                with path.open('xb') as output:
                    output.write(values[name])


def capture_result(root, plan, token, query):
    path = root / 'runs' / f'{token}.json'
    if not path.exists():
        return None
    data = path.read_bytes()
    capture = json.loads(data)
    if capture.get('schemaVersion') != 1 or capture.get('completion') not in ('success', 'error', 'timeout'):
        raise ValueError('Invalid attempt capture')
    for digest in capture['artifacts'].values():
        artifact(root, digest)
    for name in ('ptb', 'glue', 'wasm'):
        if name in capture['artifacts'] and capture['artifacts'][name] != plan['artifacts'][name]:
            raise ValueError(f'Attempt used a different {name}')
    expected_query = (canonical({'ptbSha256': plan['artifacts']['ptb'], 'tuples': [query]}) + '\n').encode()
    if 'queryTuples' in capture['artifacts'] and capture['artifacts']['queryTuples'] != sha(expected_query):
        raise ValueError('Attempt captured a different query')
    report = capture['report']
    if (report.get('glueExecution') != 'snapshot-data-url-v1' or report.get('objective') != 'plan'
            or report.get('patternMode') != 'covering-merge'):
        raise ValueError('Attempt execution contract mismatch')
    if (report.get('completion') != capture['completion'] or report.get('input', {}).get('iterations') != 2
            or report.get('input', {}).get('warmup') != 0
            or report.get('supervision', {}).get('timeoutMs') != plan['limits']['attemptTimeoutMs']
            or report.get('runtime', {}).get('node') != plan['execution']['nodeVersion']):
        raise ValueError('Attempt settings/runtime/completion mismatch')
    tuples = report.get('tuples', [])
    success = capture['completion'] == 'success'
    if success and (len(tuples) != 1 or tuples[0].get('query') != query or not all(name in capture['artifacts'] for name in ('ptb', 'glue', 'wasm', 'queryTuples'))):
        raise ValueError('Successful attempt lacks complete captured inputs/output')
    return {'completion': capture['completion'], 'captureRunId': token, 'captureManifestSha256': sha(data),
            'candidateCount': len(tuples[0]['candidates']) if success else None}


def reconcile(root, ledger):
    for record in ledger.records():
        if record['completion'] is None:
            job = json.loads(ledger.db.execute('SELECT data FROM jobs WHERE id=?', (record['job_id'],)).fetchone()[0])
            result = capture_result(root, ledger.plan, record['token'], job['query'])
            if result:
                result.update({'reconciled': True, 'elapsedMs': None})
                ledger.complete(record['token'], result['completion'], result)


def kill_group(child):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def execute(root, ledger, worker, claim, node):
    token, plan = claim['token'], ledger.plan
    work = root / 'attempts' / token
    work.mkdir(parents=True)
    query = {'ptbSha256': plan['artifacts']['ptb'], 'tuples': [claim['job']['query']]}
    query_path = work / 'queries.json'
    query_path.write_text(canonical(query) + '\n')
    args = [str(node), str(root / 'runner/temporal_baseline.mjs'), '--pkg', str(root / 'engine/pt_wasm.mjs'),
            '--ptb', str(root / 'engine/bundle.ptb'), '--query-tuples', str(query_path), '--iterations', '2', '--warmup', '0',
            '--pattern-mode', 'covering-merge', '--objective', 'plan', '--glue-execution', 'snapshot',
            '--capture-store', str(root), '--run-id', token, '--timeout-ms', str(plan['limits']['attemptTimeoutMs'])]
    file_limit = plan['limits']['attemptFileBytes']

    def restrict_files():
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))

    started = time.monotonic()
    forced = None
    with (work / 'stdout.bin').open('xb') as stdout, (work / 'stderr.bin').open('xb') as stderr:
        child = subprocess.Popen(args, stdout=stdout, stderr=stderr, start_new_session=True, preexec_fn=restrict_files, env=node_environment())
        with (work / 'process.json').open('x') as metadata:
            metadata.write(canonical({'pid': child.pid, 'processGroupId': child.pid, 'startedAtMs': now_ms()}) + '\n')
        try:
            while child.poll() is None:
                if not ledger.renew(worker, now_ms(), LEASE_MS):
                    forced = 'error'
                    kill_group(child)
                    break
                if now_ms() >= claim['expiresAtMs']:
                    forced = 'timeout'
                    kill_group(child)
                    break
                time.sleep(0.05)
        except KeyboardInterrupt:
            forced = 'cancelled'
            kill_group(child)
    try:
        result = capture_result(root, plan, token, claim['job']['query'])
    except (ValueError, OSError, KeyError, TypeError) as error:
        result = {'completion': 'error', 'captureRunId': token, 'candidateCount': None, 'reason': str(error)}
    if result and result['completion'] == 'success' and child.returncode != 0:
        result = {**result, 'completion': 'error', 'candidateCount': None, 'reason': 'capture process exited unsuccessfully'}
    if forced or not result:
        result = {'completion': forced or 'error', 'captureRunId': token if result else None,
                  'reason': 'outer process deadline/cancellation/lease loss' if forced else 'capture process exited without a valid run',
                  'candidateCount': None}
    result.update({'elapsedMs': round((time.monotonic() - started) * 1000, 3), 'exitCode': child.returncode,
                   'stdoutSha256': sha((work / 'stdout.bin').read_bytes()), 'stderrSha256': sha((work / 'stderr.bin').read_bytes())})
    ledger.complete(token, result['completion'], result)
    return result


def run_step(root, node='node'):
    if os.name != 'posix':
        raise ValueError('Pilot runner requires POSIX process groups and file limits')
    root = Path(root).resolve()
    ledger = Ledger(root / 'pilot.sqlite')
    worker = None
    try:
        settings_check(ledger.plan)
        actual, executable = runtime(node)
        if actual != ledger.plan['execution']:
            raise ValueError('Pilot runtime changed; create a separate pinned pilot')
        materialize(root, ledger.plan)
        worker = ledger.acquire(f'pid:{os.getpid()}', now_ms(), LEASE_MS)
        if not worker:
            return {'state': 'worker-busy'}
        reconcile(root, ledger)
        # Reserve generously for the known runner's bounded files plus DB
        # growth. RLIMIT_FSIZE applies to each child output file. This is not
        # a filesystem quota against arbitrary trusted glue creating new files.
        reserve = 16 * ledger.plan['limits']['attemptFileBytes'] + 1024 * 1024
        admission = 'storage-budget-exhausted' if storage_bytes(root) + reserve > ledger.plan['limits']['maxStorageBytes'] else None
        claim = ledger.claim(worker, now_ms(), GRACE_MS, admission_state=admission)
        if claim['state'] != 'claimed':
            return claim
        result = execute(root, ledger, worker, claim, executable)
        return {'state': 'attempt-recorded', 'jobId': claim['jobId'], 'attempt': claim['attempt'], **result}
    finally:
        if worker:
            ledger.release(worker)
        ledger.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init')
    init.add_argument('destination', type=Path)
    init.add_argument('source_store', type=Path)
    init.add_argument('source_run_id')
    init.add_argument('plan', type=Path)
    step = commands.add_parser('step')
    step.add_argument('pilot', type=Path)
    for command in (init, step):
        command.add_argument('--node', default='node')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    if args.command == 'init':
        result = initialize(args.destination, args.source_store, args.source_run_id, json.loads(args.plan.read_text()), args.node)
        print(canonical({'state': 'initialized', 'jobs': len(result['jobs'])}))
    else:
        result = run_step(args.pilot, args.node)
        print(canonical(result))
        if result.get('completion') == 'cancelled':
            sys.exit(130)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyboardInterrupt) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
