#!/usr/bin/env python3
"""List, raise and report versions across Rust, WASM, and Node.

Manifests carry only major.minor (always as X.Y.0). The patch is derived from
main's history by scripts/app-version.mjs; `current` prints that version.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tomllib

ROOT = Path(__file__).resolve().parents[1]
# Manifests hold major.minor only; the patch digit is always 0.
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.0\Z')


def validate_version(version):
    if not VERSION.fullmatch(version):
        raise ValueError('Bump major.minor only, as X.Y.0 without a v prefix (e.g. 0.3.0); '
                         'the patch is derived from main history')


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


def discover(root):
    # Restrict discovery to tracked source manifests, excluding node_modules and releases.
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    return sorted(p for p in files if p in ('Cargo.toml', 'package.json')
                       or re.fullmatch(r'crates/[^/]+/Cargo.toml', p)
                       or re.fullmatch(r'(?:packages|subprojects)/[^/]+/package.json', p)
                       or p == 'crates/pt-wasm/pkg-web/package.json')


def list_versions(root, manifests):
    workspace = tomllib.loads((root / 'Cargo.toml').read_text()).get('workspace', {}).get('package', {})
    rows = []
    for relative in manifests:
        if relative.endswith('package.json'):
            package = json.loads((root / relative).read_text())
            kind = 'wasm' if relative.startswith('crates/pt-wasm/') else 'node'
        else:
            package = tomllib.loads((root / relative).read_text()).get('package')
            if not package:
                continue
            kind = 'crate'
        version = package['version']
        if isinstance(version, dict):
            version = workspace['version']
        rows.append((kind, package['name'], version, relative))
    return rows


def current(root, rev):
    """The derived application version of `rev`, as the release build computes it."""
    return subprocess.check_output(['node', 'scripts/app-version.mjs', rev], cwd=root, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('list', help='List every source package and its current version')
    show = commands.add_parser('current', help='Print the derived application version (X.Y.N[-dev+sha])')
    show.add_argument('rev', nargs='?', default='HEAD', help='Commit to describe (default HEAD)')
    update = commands.add_parser('bump', help='Raise major.minor in every manifest')
    update.add_argument('version', help='New X.Y.0, without v')
    mode = update.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='Show files that would change')
    mode.add_argument('--check', action='store_true', help='Fail if selected versions differ')
    args = parser.parse_args()
    manifests = discover(ROOT)
    try:
        if args.command == 'list':
            print(f'{"TYPE":<8} {"NAME":<24} {"VERSION":<18} SOURCE')
            for kind, name, version, source in list_versions(ROOT, manifests):
                print(f'{kind:<8} {name:<24} {version:<18} {source}')
            return
        if args.command == 'current':
            print(current(ROOT, args.rev))
            return
        changes = plan(ROOT, manifests, args.version)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(2, f'{error}\n')
    for path, content in changes.items():
        print(path.relative_to(ROOT))
        if not args.dry_run and not args.check:
            path.write_text(content)
    if args.check and changes:
        parser.exit(1, 'Manifest versions do not match.\n')
    print(f'{args.version}: {len(changes)} file(s) ' + ('need updating' if args.dry_run or args.check else 'updated'))


if __name__ == '__main__':
    main()
