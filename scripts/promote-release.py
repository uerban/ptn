#!/usr/bin/env python3
"""Promote a published immutable prerelease to stable without building anything.

Release tags vX.Y.N are promoted in place: the prerelease flag is cleared and
the release marked latest, so assets and tag stay byte-identical. Legacy
vX.Y.Z-rc.N releases are copied to a stable vX.Y.Z draft (--from-rc)."""
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
    validate_prerelease(release, source_tag, revision)


def validate_published(release, tag, revision):
    if not re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag):
        raise RuntimeError('Expected a release tag such as v0.2.44')
    validate_prerelease(release, tag, revision)


def validate_prerelease(release, tag, revision):
    if (release.get('tag_name') != tag or release.get('draft') is not False
            or release.get('prerelease') is not True or release.get('immutable') is not True):
        raise RuntimeError(f'{tag} must be a published immutable prerelease')
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


def draft_release(repo, tag):
    """A draft release by tag. /releases/tags/{tag} only returns published releases."""
    pages = json.loads(gh('api', '--paginate', '--slurp', f'repos/{repo}/releases?per_page=100'))
    matches = [r for page in pages for r in page if r.get('tag_name') == tag and r.get('draft')]
    if len(matches) != 1:
        raise RuntimeError(f'Expected one draft release for {tag}, found {len(matches)}')
    return matches[0]


def verify_evidence(repo, tag, release, revision, directory):
    """Download the release, check its bytes and that its evidence names trusted exact-commit runs."""
    gh('release', 'download', tag, '--repo', repo, '--dir', str(directory))
    evidence = verify_downloads(directory, release, revision)
    # Reuse original proof without depending on expiring Actions artifacts.
    import importlib.util
    spec = importlib.util.spec_from_file_location('draft', Path(__file__).with_name('prepare-release-draft.py'))
    draft = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(draft)
    draft.validate_regression_proof(json.loads((directory / 'regression.json').read_text()), revision, evidence['regressionRunId'])
    # Release validation may come from the push to main (ptn #21), exactly as
    # the draft accepted it; regression gates are always dispatched.
    for run_id, workflow, title, main_push in ((evidence['regressionRunId'], 'regression.yml', 'Regression gates', False),
                                               (evidence['releaseRunId'], 'release.yml', 'Release validation', True)):
        if not re.fullmatch(r'[1-9][0-9]*', str(run_id)):
            raise RuntimeError('Invalid evidence run ID')
        run = api(f'repos/{repo}/actions/runs/{run_id}')
        if (run.get('conclusion') != 'success' or run.get('status') != 'completed'
                or run.get('path') != f'.github/workflows/{workflow}'
                or not draft.eligible_run(run, revision, title, main_push)):
            raise RuntimeError('Release evidence must identify successful trusted exact-commit runs')
    return evidence


def promote_in_place(repo, tag, check_only):
    release = api(f'repos/{repo}/releases/tags/{tag}')
    revision = api(f'repos/{repo}/commits/{tag}')['sha']
    validate_published(release, tag, revision)
    with tempfile.TemporaryDirectory(prefix='ptn-promotion-') as work:
        evidence = verify_evidence(repo, tag, release, revision, Path(work))
    if evidence.get('version') != tag[1:]:
        raise RuntimeError(f'Release evidence records version {evidence.get("version")!r}, not {tag[1:]}')
    if check_only:
        print(f'PASS: {tag} can be promoted in place at {revision}')
        return
    gh('release', 'edit', tag, '--repo', repo, '--prerelease=false', '--latest')
    after = api(f'repos/{repo}/releases/tags/{tag}')
    if (after.get('prerelease') is not False or after.get('immutable') is not True
            or {a['name']: a.get('digest') for a in after.get('assets', [])}
            != {a['name']: a['digest'] for a in release['assets']}):
        raise RuntimeError(f'{tag} did not become a stable release with unchanged assets; check it by hand')
    print(f'Promoted {tag} to stable and latest; assets unchanged')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    parser.add_argument('--from-rc', help='Legacy: copy this vX.Y.Z-rc.N release to a stable vX.Y.Z draft')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    repo = os.environ['GH_REPO']
    if not args.from_rc:
        promote_in_place(repo, args.tag, args.check_only)
        return
    release = api(f'repos/{repo}/releases/tags/{args.from_rc}')
    revision = api(f'repos/{repo}/commits/{args.from_rc}')['sha']
    validate_source(release, args.from_rc, args.tag, revision)
    # Stable tag must already exist and resolve to the RC commit. Never create
    # or move tags implicitly, and never dispatch a build on this path.
    if api(f'repos/{repo}/commits/{args.tag}')['sha'] != revision:
        raise RuntimeError('Stable tag and RC must identify the exact same commit')
    with tempfile.TemporaryDirectory(prefix='ptn-promotion-') as work:
        directory = Path(work)
        verify_evidence(repo, args.from_rc, release, revision, directory)
        if args.check_only:
            print(f'PASS: {args.from_rc} -> {args.tag}, identical assets at {revision}')
            return
        notes = (f'Promoted unchanged from {release["html_url"]}.\n\nSource commit: {revision}\n\n'
                 'All archives and validation evidence are byte-identical to the RC. '
                 'Release labels do not alter embedded component versions. '
                 'Environment acceptance is recorded separately by operators.')
        gh('release', 'create', args.tag, '--repo', repo, '--verify-tag', '--draft',
           '--title', args.tag, '--notes', notes, *(str(directory / name) for name in sorted(ARCHIVES | EVIDENCE)))
        target = draft_release(repo, args.tag)
        source_digests = {a['name']: a['digest'] for a in release['assets']}
        if {a['name']: a.get('digest') for a in target['assets']} != source_digests:
            raise RuntimeError('Uploaded stable assets differ from the RC; leave draft unpublished')
        print(f'Created stable draft {args.tag} from {args.from_rc}; publication remains manual')


if __name__ == '__main__':
    main()
