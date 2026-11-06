#!/usr/bin/env python3
"""Copy a published immutable RC to a stable draft without building anything."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

PLATFORMS = ('linux-x86_64', 'linux-armv6-rpi1', 'linux-aarch64-rpi3', 'darwin-arm64', 'darwin-x86_64')
ARCHIVES = {f'ptn-{p}.tar.gz{s}' for p in PLATFORMS for s in ('', '.sha256')}
EVIDENCE = {'release-evidence.json', 'regression.json'}


def gh(*args):
    return subprocess.check_output(['gh', *args], text=True).strip()


def api(path):
    return json.loads(gh('api', path))


def validate_source(release, source_tag, tag, revision):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise RuntimeError('Promotion target must be a stable version tag')
    if not re.fullmatch(re.escape(tag) + r'-rc\.[1-9][0-9]*', source_tag):
        raise RuntimeError('Source must be an RC of the target version, such as v0.2.0-rc.1')
    if (release.get('tag_name') != source_tag or release.get('draft') is not False
            or release.get('prerelease') is not True or release.get('immutable') is not True):
        raise RuntimeError('Source must be a published immutable RC prerelease')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise RuntimeError('Invalid source commit')
    assets = release.get('assets', [])
    if len(assets) != len({a['name'] for a in assets}) or {a['name'] for a in assets} != ARCHIVES | EVIDENCE:
        raise RuntimeError('RC asset set is incomplete or unexpected')
    if any(not re.fullmatch(r'sha256:[0-9a-f]{64}', a.get('digest') or '') for a in assets):
        raise RuntimeError('Every immutable RC asset must have a GitHub SHA-256 digest')


def verify_downloads(directory, release, revision):
    for asset in release['assets']:
        with (directory / asset['name']).open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if asset['digest'] != 'sha256:' + digest:
            raise RuntimeError(f'Immutable asset digest mismatch: {asset["name"]}')
    evidence = json.loads((directory / 'release-evidence.json').read_text())
    if evidence.get('schemaVersion') != 1 or evidence.get('revision') != revision:
        raise RuntimeError('Release evidence source mismatch')
    expected = ARCHIVES | {'regression.json'}
    if set(evidence.get('sha256', {})) != expected:
        raise RuntimeError('Release evidence does not cover the complete artifact set')
    for name, digest in evidence['sha256'].items():
        with (directory / name).open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != digest:
            raise RuntimeError(f'Release evidence digest mismatch: {name}')
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    parser.add_argument('--from-rc', required=True)
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    repo = os.environ['GH_REPO']
    release = api(f'repos/{repo}/releases/tags/{args.from_rc}')
    revision = api(f'repos/{repo}/commits/{args.from_rc}')['sha']
    validate_source(release, args.from_rc, args.tag, revision)
    # Stable tag must already exist and resolve to the RC commit. Never create
    # or move tags implicitly, and never dispatch a build on this path.
    if api(f'repos/{repo}/commits/{args.tag}')['sha'] != revision:
        raise RuntimeError('Stable tag and RC must identify the exact same commit')
    with tempfile.TemporaryDirectory(prefix='ptn-promotion-') as work:
        directory = Path(work)
        gh('release', 'download', args.from_rc, '--repo', repo, '--dir', work)
        evidence = verify_downloads(directory, release, revision)
        # Reuse original proof without depending on expiring Actions artifacts.
        import importlib.util
        spec = importlib.util.spec_from_file_location('draft', Path(__file__).with_name('prepare-release-draft.py'))
        draft = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(draft)
        draft.validate_regression_proof(json.loads((directory / 'regression.json').read_text()), revision, evidence['regressionRunId'])
        for run_id, workflow, title in ((evidence['regressionRunId'], 'regression.yml', 'Regression gates'),
                                        (evidence['releaseRunId'], 'release.yml', 'Release validation')):
            if not re.fullmatch(r'[1-9][0-9]*', str(run_id)):
                raise RuntimeError('Invalid evidence run ID')
            run = api(f'repos/{repo}/actions/runs/{run_id}')
            if (run.get('conclusion') != 'success' or run.get('status') != 'completed'
                    or run.get('path') != f'.github/workflows/{workflow}'
                    or not draft.eligible_run(run, revision, title)):
                raise RuntimeError('Release evidence must identify successful trusted exact-commit runs')
        if args.check_only:
            print(f'PASS: {args.from_rc} -> {args.tag}, identical assets at {revision}')
            return
        notes = (f'Promoted unchanged from {release["html_url"]}.\n\nSource commit: {revision}\n\n'
                 'All archives and validation evidence are byte-identical to the RC. '
                 'Release labels do not alter embedded component versions. '
                 'Environment acceptance is recorded separately by operators.')
        gh('release', 'create', args.tag, '--repo', repo, '--verify-tag', '--draft',
           '--title', args.tag, '--notes', notes, *(str(directory / name) for name in sorted(ARCHIVES | EVIDENCE)))
        target = api(f'repos/{repo}/releases/tags/{args.tag}')
        source_digests = {a['name']: a['digest'] for a in release['assets']}
        if {a['name']: a.get('digest') for a in target['assets']} != source_digests:
            raise RuntimeError('Uploaded stable assets differ from the RC; leave draft unpublished')
        print(f'Created stable draft {args.tag} from {args.from_rc}; publication remains manual')


if __name__ == '__main__':
    main()
