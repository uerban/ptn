#!/usr/bin/env python3
"""Draft a prerelease from validated archives for one exact tag commit; never rebuild partial runs.

Release tags are vX.Y.N, set by a human on a validated main commit; N must be
the version the release run derived for that commit (release.json). Legacy
vX.Y.Z-rc.N tags are still accepted for the 0.2.3 line."""
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


VERSION_TAG = r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
LEGACY_RC_TAG = r'v[0-9]+\.[0-9]+\.[0-9]+-rc\.[1-9][0-9]*'


def tag_version(tag):
    """X.Y.N for a release tag, None for a legacy RC tag; anything else is rejected."""
    if re.fullmatch(VERSION_TAG, tag):
        return tag[1:]
    if re.fullmatch(LEGACY_RC_TAG, tag):
        return None
    raise RuntimeError('Expected a release tag vX.Y.N (or a legacy vX.Y.Z-rc.N)')


def check_archive_version(meta, version, name):
    if version is not None and meta.get('version') != version:
        raise RuntimeError(f'{name} was built as version {meta.get("version")!r}, not {version}: '
                           'tag the main commit whose derived version matches the tag')


TEMPLATE = Path(__file__).resolve().parent.parent / 'docs' / 'templates' / 'release-notes.md'
PLACEHOLDER = re.compile(r'\{\{([A-Z_]+)\}\}')
# Filled by a person before promotion; promote-release.py refuses them.
EDITORIAL = ('SUMMARY', 'ATTENTION', 'RIDERS', 'SELF_HOSTING', 'UPGRADING')


def release_title(tag):
    return f'PTN {tag}'


def render_notes(template, values):
    """Fill the release-notes template; editorial placeholders stay for review."""
    text = re.sub(r'<!--.*?-->\n?', '', template, flags=re.S)
    unknown = set(PLACEHOLDER.findall(text)) - set(values) - set(EDITORIAL)
    if unknown:
        raise RuntimeError(f'Release-notes template has unknown placeholders: {", ".join(sorted(unknown))}')
    return PLACEHOLDER.sub(lambda m: values.get(m[1], m[0]), text).strip() + '\n'


PR_GROUPS = ('Breaking changes', 'Security and dependencies', 'Features', 'Fixes', 'Documentation', 'Maintenance')
CONVENTIONAL = re.compile(r'(?P<type>[a-z]+)(?:\((?P<scope>[^)]*)\))?(?P<breaking>!)?: ')


def pr_group(title):
    """Group a pull request by its Conventional Commits title; other titles count as fixes."""
    match = CONVENTIONAL.match(title)
    kind, scope = (match['type'], match['scope'] or '') if match else ('fix', '')
    if match and match['breaking']:
        return 'Breaking changes'
    if kind == 'security' or scope == 'deps' or re.search(r'\b(RUSTSEC|CVE|GHSA)-', title):
        return 'Security and dependencies'
    if kind in ('feat', 'perf'):
        return 'Features'
    if kind == 'fix':
        return 'Fixes'
    if kind == 'docs':
        return 'Documentation'
    return 'Maintenance'


def group_pull_requests(body):
    """GitHub's generated notes, grouped under headings; new contributors are kept."""
    groups = {name: [] for name in PR_GROUPS}
    contributors, section = [], None
    for line in body.splitlines():
        if line.startswith('## '):
            section = line[3:].strip()
        elif line.startswith('* ') and section == 'New Contributors':
            contributors.append(line)
        elif line.startswith('* '):
            groups[pr_group(line[2:].split(' by @')[0])].append(line)
    parts = [f'### {name}\n\n' + '\n'.join(lines) for name, lines in groups.items() if lines]
    if contributors:
        parts.append('### New contributors\n\n' + '\n'.join(contributors))
    return '\n\n'.join(parts) or 'No pull requests.'


def pull_requests(repo, tag, previous):
    """Merged pull requests between the previous stable release and tag."""
    generated = json.loads(gh('api', '-X', 'POST', f'repos/{repo}/releases/generate-notes',
                              '-f', f'tag_name={tag}', '-f', f'previous_tag_name={previous}'))
    return group_pull_requests(generated['body'])


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
    version = tag_version(args.tag)
    repo = os.environ['GH_REPO']
    if version is not None and api(f'repos/{repo}/git/matching-refs/tags/{args.tag}-rc.'):
        # A legacy stable tag (its RC line exists): drafting it would dispatch
        # gates for archives that carry no version. Promote the RC instead.
        raise RuntimeError(f'{args.tag} is a legacy stable tag; use promote-release.py {args.tag} --from-rc <rc tag>')
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
        check_archive_version(meta, version, name)
    if version is None:
        notes = (f'Validated archives from {run["html_url"]}\n\nRegression gates: {gate["html_url"]}\n\n'
                 f'Source commit: {revision}\n\nIncludes Linux x86_64, ARMv6 and AArch64, and macOS Apple Silicon '
                 'and Intel. ARM smoke checks use QEMU; full native and Docker lifecycle checks run on Linux x86_64.')
    else:
        previous = api(f'repos/{repo}/releases/latest')['tag_name']
        notes = render_notes(TEMPLATE.read_text(), {
            'VERSION': version, 'TAG': args.tag, 'PREVIOUS_TAG': previous,
            'VALIDATION_RUN_URL': run['html_url'], 'REGRESSION_RUN_URL': gate['html_url'],
            'SOURCE_SHA': revision, 'SHORT_SHA': revision[:7],
            'PULL_REQUESTS': pull_requests(repo, args.tag, previous)})
    (dest / 'regression.json').write_text(json.dumps(proof, indent=2) + '\n')
    hashes = {}
    for path in sorted(dest.iterdir()):
        with path.open('rb') as stream:
            hashes[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    (dest / 'release-evidence.json').write_text(json.dumps({
        'schemaVersion': 1, 'revision': revision, 'releaseRunId': str(run['id']),
        'regressionRunId': str(gate['id']), 'sha256': hashes,
        **({'version': version} if version else {}),
    }, indent=2) + '\n')
    flags = ['--prerelease']
    gh('release', 'create', args.tag, '--repo', repo, '--verify-tag', '--draft', *flags,
       '--title', release_title(args.tag), '--notes', notes,
       *(str(path) for path in sorted(dest.iterdir())))


if __name__ == '__main__':
    main()
