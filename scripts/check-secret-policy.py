#!/usr/bin/env python3
"""Prove narrow scan exceptions do not suppress another key or another path."""
import base64
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    binary = os.environ.get('GITLEAKS_BIN', 'gitleaks')
    with tempfile.TemporaryDirectory(dir=os.environ.get('RUNNER_TEMP')) as directory:
        root = Path(directory)
        path = root / 'crates/pt-artifacts/src/bin/pt-artifact-publish.rs'
        path.parent.mkdir(parents=True)
        source = ROOT / path.relative_to(root)
        path.write_bytes(source.read_bytes())
        command = [binary, 'dir', '.', '--config', str(ROOT / '.gitleaks.toml'), '--redact=100', '--no-banner']
        subprocess.run(command, cwd=root, check=True)
        # Ephemeral synthetic PKCS#8 seed, never an operational credential.
        body = base64.b64encode(bytes.fromhex('302e020100300506032b657004220420') + bytes(range(32))).decode()
        begin, end = '-----BEGIN ' + 'PRIVATE KEY-----', '-----END ' + 'PRIVATE KEY-----'
        path.write_text(begin + '\n' + body + '\n' + end + '\n')
        if subprocess.run(command, cwd=root).returncode != 1:
            raise SystemExit('A different key in the allowlisted parser path was not detected')
        path.unlink()
        (root / 'other.rs').write_bytes(source.read_bytes())
        if subprocess.run(command, cwd=root).returncode != 1:
            raise SystemExit('Parser exceptions escaped their exact path')
    print('PASS: parser/RFC literals accepted; other keys and paths rejected')


if __name__ == '__main__':
    main()
