#!/usr/bin/env python3
"""Synchronize release versions without changing dependency or wire-format versions."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
# SemVer shared by Cargo and npm; build metadata is deliberately unsupported.
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z')


def validate_version(version):
    match = VERSION.fullmatch(version)
    if not match or (match[4] and any(part.isdigit() and len(part) > 1 and part[0] == '0'
                                    for part in match[4].split('.'))):
        raise ValueError('Use SemVer without a v prefix or build metadata, e.g. 0.1.2 or 0.2.0-rc.1')


def replace_toml_version(text, section, version):
    pattern = re.compile(r'(^\[' + re.escape(section) + r'\]\s*\n)(.*?)(?=^\[|\Z)', re.M | re.S)
    def replace(match):
        body, count = re.subn(r'^(version\s*=\s*)"[^"\n]+"',
                              lambda m: m[1] + json.dumps(version), match[2], count=1, flags=re.M)
        if count != 1:
            raise ValueError(f'No literal version in [{section}]')
        return match[1] + body
    result, count = pattern.subn(replace, text, count=1)
    if count != 1:
        raise ValueError(f'Missing [{section}]')
    return result


def plan(root, manifests, version):
    """Validate all inputs and prepare every edit before writing any file."""
    validate_version(version)
    changes = {}
    crates = {}
    for relative in manifests:
        path = root / relative
        original = path.read_text()
        if path.name == 'package.json':
            data = json.loads(original)
            if 'version' not in data:
                raise ValueError(f'Missing package version: {relative}')
            data['version'] = version
            updated = json.dumps(data, indent=2, ensure_ascii=False) + '\n'
        else:
            data = tomllib.loads(original)
            if 'package' not in data:
                if 'version' not in data.get('workspace', {}).get('package', {}):
                    continue
                updated = replace_toml_version(original, 'workspace.package', version)
            else:
                crates[data['package']['name']] = data['package']['version']
                if isinstance(data['package']['version'], dict):
                    if not data['package']['version'].get('workspace'):
                        raise ValueError(f'Unsupported inherited version: {relative}')
                    continue
                updated = replace_toml_version(original, 'package', version)
        if updated != original:
            changes[path] = updated
    lock = root / 'Cargo.lock'
    original = lock.read_text()
    blocks = re.split(r'(?=^\[\[package\]\]\s*$)', original, flags=re.M)
    found = set()
    for i, block in enumerate(blocks):
        if not block.startswith('[[package]]'):
            continue
        package = tomllib.loads(block)['package'][0]
        if package['name'] in crates and 'source' not in package:
            found.add(package['name'])
            blocks[i] = re.sub(r'^(version\s*=\s*)"[^"\n]+"',
                               lambda m: m[1] + json.dumps(version), block, count=1, flags=re.M)
    if found != crates.keys():
        raise ValueError(f'Workspace crates missing from Cargo.lock: {sorted(crates.keys() - found)}')
    updated = ''.join(blocks)
    if updated != original:
        changes[lock] = updated
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', help='Explicit release version, without v')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='Show files that would change')
    mode.add_argument('--check', action='store_true', help='Fail if versions differ from the requested version')
    args = parser.parse_args()
    # Restrict discovery to tracked source manifests, excluding node_modules and releases.
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    manifests = sorted(p for p in files if p in ('Cargo.toml', 'package.json')
                       or re.fullmatch(r'crates/[^/]+/Cargo.toml', p)
                       or re.fullmatch(r'(?:packages|subprojects)/[^/]+/package.json', p)
                       or p == 'crates/pt-wasm/pkg-web/package.json')
    try:
        changes = plan(ROOT, manifests, args.version)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(2, f'{error}\n')
    for path, content in changes.items():
        print(path.relative_to(ROOT))
        if not args.dry_run and not args.check:
            path.write_text(content)
    if args.check and changes:
        parser.exit(1, 'Release versions are not synchronized.\n')
    print(f'{args.version}: {len(changes)} file(s) ' + ('need updating' if args.dry_run or args.check else 'updated'))


if __name__ == '__main__':
    main()
