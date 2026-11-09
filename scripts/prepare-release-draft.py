#!/usr/bin/env python3
"""Promote validated archives for one exact tag commit; never rebuild partial runs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time

PLATFORMS = ('linux-x86_64', 'linux-armv6-rpi1', 'linux-aarch64-rpi3', 'darwin-arm64', 'darwin-x86_64')
REQUIRED = {f'ptn-{p}' for p in PLATFORMS}


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True).strip()


def api(path):
    return json.loads(gh('api', path))


def artifact_state(artifacts, required=REQUIRED):
    by_name = {a['name']: a for a in artifacts}
    missing = required - by_name.keys()
    if missing:
        raise RuntimeError(f'Missing required artifacts: {", ".join(sorted(missing))}; refusing automatic rebuild')
    return 'expired' if any(by_name[n]['expired'] for n in required) else 'ready'


REGRESSION_CHECKS = {'identity', 'wasm', 'parity', 'rss', 'index', 'bundle', 'heap', 'coldstart', 'cityswitch'}


def validate_regression_proof(proof, revision, run_id):
    checks = proof.get('checks', {})
    if (proof.get('schemaVersion') != 1 or proof.get('revision') != revision
            or proof.get('passed') is not True or proof.get('sourceDirty') is not False
            or proof.get('runId') != str(run_id) or proof.get('runner') != 'Linux'
            or set(checks) != REGRESSION_CHECKS
            or any(value != 'success' for value in checks.values())):
        raise RuntimeError('Regression evidence is incomplete, failed or for another source revision')


def eligible_run(run, revision, title, allow_main_push=False):
    return (run['event'] == 'workflow_dispatch' and run['head_branch'] == 'main'
            and run['display_title'] == f'{title} {revision}') or (
                allow_main_push and run['event'] == 'push' and run['head_branch'] == 'main'
                and run['head_sha'] == revision)


def ensure_validation(repo, revision, filename, title, required, check_only, allow_main_push=False):
    workflow = f'repos/{repo}/actions/workflows/{filename}'
    pages = json.loads(gh('api', '--paginate', '--slurp', f'{workflow}/runs?per_page=100'))
    runs = [run for page in pages for run in page['workflow_runs']]
    candidates = [run for run in runs if eligible_run(run, revision, title, allow_main_push)]
    run = max(candidates, key=lambda item: item['id']) if candidates else None
    if run:
        if run['status'] != 'completed':
            gh('run', 'watch', str(run['id']), '--repo', repo, '--exit-status', '--interval', '20')
            run = api(f'repos/{repo}/actions/runs/{run["id"]}')
        if run['conclusion'] != 'success':
            raise RuntimeError(f'{title} run {run["id"]} failed: {run["conclusion"]}')
        artifacts = api(f'repos/{repo}/actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
        state = artifact_state(artifacts, required)
    else:
        state = 'unbuilt'
    if state == 'ready':
        return run
    if check_only:
        raise RuntimeError(f'{title} required for {revision}: {state}')
    previous_ids = {item['id'] for item in runs}
    gh('workflow', 'run', filename, '--repo', repo, '--ref', 'main', '-f', f'revision={revision}')
    for _ in range(60):
        recent = api(f'{workflow}/runs?event=workflow_dispatch&branch=main&per_page=100')['workflow_runs']
        matches = [item for item in recent if item['id'] not in previous_ids
                   and eligible_run(item, revision, title)]
        if matches:
            run = min(matches, key=lambda item: item['id'])
            break
        time.sleep(5)
    else:
        raise RuntimeError(f'Dispatched {title} did not appear within five minutes')
    gh('run', 'watch', str(run['id']), '--repo', repo, '--exit-status', '--interval', '20')
    run = api(f'repos/{repo}/actions/runs/{run["id"]}')
    if run['conclusion'] != 'success':
        raise RuntimeError(f'{title} failed: {run["conclusion"]}')
    artifacts = api(f'repos/{repo}/actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
    if artifact_state(artifacts, required) != 'ready':
        raise RuntimeError(f'{title} artifacts are expired')
    return run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', args.tag):
        raise RuntimeError('Expected a version tag such as v0.1.1')
    if '-' not in args.tag:
        raise RuntimeError('Stable releases must be promoted from an immutable RC using promote-release.py')
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*', args.tag):
        raise RuntimeError('Expected an RC tag such as v0.2.0-rc.1')
    repo = os.environ['GH_REPO']
    revision = api(f'repos/{repo}/commits/{args.tag}')['sha']
    gate = ensure_validation(repo, revision, 'regression.yml', 'Regression gates',
                             {'regression-proof'}, args.check_only)
    with tempfile.TemporaryDirectory(prefix='ptn-regression-proof-') as directory:
        gh('run', 'download', str(gate['id']), '--repo', repo, '--name', 'regression-proof', '--dir', directory)
        proof = json.loads((Path(directory) / 'regression.json').read_text())
        validate_regression_proof(proof, revision, gate['id'])
    run = ensure_validation(repo, revision, 'release.yml', 'Release validation', REQUIRED,
                            args.check_only, allow_main_push=True)
    print(f'{args.tag}: exact-commit regression gate and release artifacts ready', flush=True)
    if args.check_only:
        return
    dest = Path('release-draft')
    dest.mkdir(exist_ok=False)
    for name in sorted(REQUIRED):
        gh('run', 'download', str(run['id']), '--repo', repo, '--name', name, '--dir', str(dest))
    for platform in PLATFORMS:
        name = f'ptn-{platform}.tar.gz'
        archive = dest / name
        checksum = (dest / f'{name}.sha256').read_text().split()
        with archive.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if len(checksum) != 2 or checksum[1].lstrip('*') != name or digest != checksum[0]:
            raise RuntimeError(f'Invalid checksum: {name}')
        with tarfile.open(archive) as bundle:
            meta = json.load(bundle.extractfile(f'ptn-{platform}/release.json'))
        if meta['revision'] != revision or meta['sourceDirty'] or meta['platform'] != platform:
            raise RuntimeError(f'Archive source mismatch: {name}')
    notes = (f'Validated archives from {run["html_url"]}\n\nRegression gates: {gate["html_url"]}\n\nSource commit: {revision}\n\n'
             'Includes Linux x86_64, ARMv6 and AArch64, and macOS Apple Silicon and Intel. '
             'ARM smoke checks use QEMU; full native and Docker lifecycle checks run on Linux x86_64.')
    (dest / 'regression.json').write_text(json.dumps(proof, indent=2) + '\n')
    hashes = {}
    for path in sorted(dest.iterdir()):
        with path.open('rb') as stream:
            hashes[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    (dest / 'release-evidence.json').write_text(json.dumps({
        'schemaVersion': 1, 'revision': revision, 'releaseRunId': str(run['id']),
        'regressionRunId': str(gate['id']), 'sha256': hashes,
    }, indent=2) + '\n')
    flags = ['--prerelease']
    gh('release', 'create', args.tag, '--repo', repo, '--verify-tag', '--draft', *flags,
       '--title', args.tag, '--notes', notes,
       *(str(path) for path in sorted(dest.iterdir())))


if __name__ == '__main__':
    main()
