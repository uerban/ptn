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
import time

PLATFORMS = ('linux-x86_64', 'linux-armv6-rpi1', 'linux-aarch64-rpi3', 'darwin-arm64', 'darwin-x86_64')
REQUIRED = {f'ptn-{p}' for p in PLATFORMS}


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True).strip()


def api(path):
    return json.loads(gh('api', path))


def artifact_state(artifacts):
    by_name = {a['name']: a for a in artifacts}
    missing = REQUIRED - by_name.keys()
    if missing:
        raise RuntimeError(f'Missing required artifacts: {", ".join(sorted(missing))}; refusing automatic rebuild')
    return 'expired' if any(by_name[n]['expired'] for n in REQUIRED) else 'ready'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', args.tag):
        raise RuntimeError('Expected a version tag such as v0.1.1')
    repo = os.environ['GH_REPO']
    revision = api(f'repos/{repo}/commits/{args.tag}')['sha']
    workflow = f'repos/{repo}/actions/workflows/release.yml'
    runs = json.loads(gh('api', '--paginate', '--slurp', f'{workflow}/runs?per_page=100'))
    candidates = [r for page in runs for r in page['workflow_runs']
                  if (r['head_sha'] == revision and r['event'] == 'push' and r['head_branch'] == 'main')
                  or (r['event'] == 'workflow_dispatch' and r['head_branch'] == 'main'
                      and r['display_title'] == f'Release validation {revision}')]
    run = max(candidates, key=lambda r: r['id']) if candidates else None
    if run:
        if run['status'] != 'completed':
            gh('run', 'watch', str(run['id']), '--repo', repo, '--exit-status', '--interval', '20')
            run = api(f'repos/{repo}/actions/runs/{run["id"]}')
        if run['conclusion'] != 'success':
            raise RuntimeError(f'Validation run {run["id"]} failed: {run["conclusion"]}')
        artifacts = api(f'repos/{repo}/actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
        state = artifact_state(artifacts)
    else:
        state = 'unbuilt'
    print(f'{args.tag}: {revision}, artifacts {state}', flush=True)
    if args.check_only:
        return
    if state != 'ready':
        previous_ids = {r['id'] for page in runs for r in page['workflow_runs']}
        gh('workflow', 'run', 'release.yml', '--repo', repo, '--ref', 'main', '-f', f'revision={revision}')
        # Dispatch has no run ID response. The release workflow serializes drafts.
        for _ in range(60):
            recent = api(f'{workflow}/runs?event=workflow_dispatch&branch=main&per_page=100')['workflow_runs']
            matches = [r for r in recent if r['id'] not in previous_ids
                       and r['display_title'] == f'Release validation {revision}']
            if matches:
                run = min(matches, key=lambda r: r['id'])
                break
            time.sleep(5)
        else:
            raise RuntimeError('Dispatched build did not appear within five minutes')
        subprocess.run(['gh', 'run', 'watch', str(run['id']), '--repo', repo, '--exit-status', '--interval', '20'], check=True)
        run = api(f'repos/{repo}/actions/runs/{run["id"]}')
        if run['conclusion'] != 'success':
            raise RuntimeError(f'Rebuild failed: {run["conclusion"]}')
        artifacts = api(f'repos/{repo}/actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
        if artifact_state(artifacts) != 'ready':
            raise RuntimeError('Rebuild artifacts are expired')
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
    notes = (f'Validated archives from {run["html_url"]}\n\nSource commit: {revision}\n\n'
             'Includes Linux x86_64, ARMv6 and AArch64, and macOS Apple Silicon and Intel. '
             'ARM smoke checks use QEMU; full native and Docker lifecycle checks run on Linux x86_64.')
    flags = ['--prerelease'] if '-' in args.tag else []
    gh('release', 'create', args.tag, '--repo', repo, '--verify-tag', '--draft', *flags,
       '--title', args.tag, '--notes', notes,
       *(str(dest / f'ptn-{p}.tar.gz{s}') for p in PLATFORMS for s in ('', '.sha256')))


if __name__ == '__main__':
    main()
