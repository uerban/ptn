#!/usr/bin/env python3
"""Keep prose-only changes cheap; unknown files/events require source CI."""
import argparse
import json
from pathlib import PurePosixPath, Path
import subprocess


def documentation_only(paths):
    def prose(name):
        path = PurePosixPath(name)
        return path.name == 'README.md' or (len(path.parts) == 1 and (path.suffix == '.md' or name in ('LICENSE', 'NOTICE'))) or (
            path.suffix == '.md' and path.parts[0] in ('docs', '.github'))
    return bool(paths) and all(prose(path) for path in paths)


def changed_paths(event, payload):
    if event == 'pull_request':
        base = payload['pull_request']['base']['sha']
        revision = f'{base}...HEAD'
    elif event == 'push' and payload.get('before', '').strip('0'):
        revision = f'{payload["before"]}..HEAD'
    else:
        return None
    # Include deleted paths and both sides of a rename; no truncated API file list.
    return subprocess.check_output(['git', 'diff', '--no-renames', '--name-only', '-z', revision]).decode().rstrip('\0').split('\0')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event', required=True)
    parser.add_argument('--payload', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    paths = changed_paths(args.event, json.loads(args.payload.read_text()))
    source = paths is None or not documentation_only(paths)
    with args.output.open('a') as output:
        output.write(f'source={str(source).lower()}\n')
    print('Source build required' if source else 'Prose-only change: source build omitted')


if __name__ == '__main__':
    main()
