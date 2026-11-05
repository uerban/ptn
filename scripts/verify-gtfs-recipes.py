#!/usr/bin/env python3
"""Real canonical gate over synthetic HTTPS raw/recipe inputs; no operator data."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import ssl
import subprocess
import threading
import zipfile
from unittest.mock import patch
from test_gtfs_refresh import archive, fixture, gtfs


def verify(work, validator):
    work.mkdir(parents=True, exist_ok=False)
    served = work / 'http'
    served.mkdir()
    fixture(served / 'good.zip')
    with zipfile.ZipFile(served / 'good.zip') as original, zipfile.ZipFile(served / 'raw.zip', 'w') as output:
        for name in original.namelist():
            data = original.read(name)
            output.writestr(name, data.replace(b'r,s,t', b'missing,s,t') if name == 'trips.txt' else data)
    openssl = work / 'openssl.cnf'
    openssl.write_text('[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n')
    cert, key = work / 'ca.pem', work / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', str(openssl), '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'https://localhost:{server.server_port}'
    step = b'''import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2],'w') as out:
 for name in source.namelist():
  value=source.read(name)
  out.writestr(name,value.replace(b'missing,s,t',b'r,s,t') if name=='trips.txt' else value)
'''
    recipe_path = archive(served / 'recipe.tar.gz', {
        'schemaVersion': 1, 'city': 'riga', 'timezone': 'Europe/Riga',
        'requiredSourceIds': ['one', 'two'],
        'sources': [{'id': name, 'url': base + '/raw.zip', 'steps': ['scripts/prepare.py']} for name in ('one', 'two')],
    }, {'repo/scripts/prepare.py': step})
    config = {'city': 'riga', 'timezone': 'Europe/Riga', 'gtfsRecipe': {
        'url': base + '/recipe.tar.gz', 'sha256': gtfs.digest(recipe_path), 'name': 'test'}}
    try:
        with patch.dict(os.environ, {'SSL_CERT_FILE': str(cert), 'PT_FEEDS_TOKEN': ''}):
            result = gtfs.prepare(config, work / 'recipe-state', validator=validator)
            assert result['passed'] and len(result['feeds']) == 2
            assert all(record['originalCanonical']['errors'] and not record['originalCanonical']['blocking'] for record in result['feeds'])
            repeated = gtfs.prepare(config, work / 'recipe-state', validator=validator)
            assert all(record['reusedPreparation'] for record in repeated['feeds'])
            pointer = work / 'recipe-state/latest-validated.json'
            previous = pointer.read_bytes()
            (served / 'raw.zip').unlink()
            try:
                gtfs.prepare(config, work / 'recipe-state', validator=validator)
            except OSError:
                pass
            else:
                raise AssertionError('unavailable source was accepted')
            assert pointer.read_bytes() == previous
            raw = gtfs.prepare({'city': 'riga', 'timezone': 'Europe/Riga', 'gtfsURL': base + '/good.zip'}, work / 'raw-state', validator=validator)
            assert raw['passed']
            (work / 'acceptance.json').write_text(json.dumps({'passed': True, 'raw': True, 'recipe': True,
                'namespacedComponents': 2, 'originalErrorsInformational': True,
                'unchangedPreparationReused': True, 'sourceFailurePreservesCandidate': True,
                'validatorSha256': gtfs.VALIDATOR_SHA, 'runtimeSha256': gtfs.digest(gtfs.__file__)}, indent=2) + '\n')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', required=True, type=Path)
    parser.add_argument('--validator', required=True, type=Path)
    args = parser.parse_args()
    verify(args.work.resolve(), args.validator.resolve())
