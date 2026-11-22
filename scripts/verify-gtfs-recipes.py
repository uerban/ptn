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
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from test_gtfs_refresh import archive, fixture, gtfs, versioned


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
            sources = verify_sources(work, served, base, validator)
            (work / 'acceptance.json').write_text(json.dumps({'passed': True, 'raw': True, 'recipe': True,
                'namespacedComponents': 2, 'originalErrorsInformational': True,
                'unchangedPreparationReused': True, 'sourceFailurePreservesCandidate': True,
                'sourceMirrors': sources,
                'validatorSha256': gtfs.VALIDATOR_SHA, 'runtimeSha256': gtfs.digest(gtfs.__file__)}, indent=2) + '\n')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def verify_sources(work, served, base, validator):
    """Schema 2 origin/mirror selection against real HTTPS and the real gate."""
    today = datetime.now(ZoneInfo('Europe/Riga')).date()
    yesterday = today - timedelta(days=1)

    def publish(name, version):
        versioned(served / name, version=version.isoformat())

    def recipe(name, **source):
        path = archive(served / f'{name}.tar.gz', {
            'schemaVersion': 2, 'city': 'riga', 'timezone': 'Europe/Riga', 'requiredSourceIds': ['one'],
            'sources': [{'id': 'one', 'url': base + '/origin.zip', 'identity': {'agencyNames': ['Synthetic'], 'agencyCount': 1},
                         'mirror': {'operator': 'Acceptance mirror', 'url': base + '/mirror.zip'}, **source}],
        })
        return {'city': 'riga', 'timezone': 'Europe/Riga', 'gtfsRecipe': {'archive': str(path), 'sha256': gtfs.digest(path), 'name': 'test'}}

    credentialed = {
        'prefer': 'mirror', 'auth': {'queryParam': 'key', 'env': 'ACCEPTANCE_KEY'},
        'budget': {'requests': 1, 'days': 30},
        'freshness': {'signal': 'feed_info.feed_version', 'format': '%Y-%m-%d', 'maxAgeDays': 0},
    }
    budget = work / 'budget'
    with patch.dict(os.environ, {'PT_FEEDS_BUDGET_DIR': str(budget), 'ACCEPTANCE_KEY': 'acceptance-key'}):
        # Origin first, origin missing (404): the mirror serves, with a warning.
        publish('mirror.zip', today)
        result = gtfs.prepare(recipe('originfirst'), work / 'origin-first-state', validator=validator)
        retrieval = result['feeds'][0]['retrieval']
        assert result['passed'] and retrieval['candidate']['kind'] == 'mirror'
        assert retrieval['attempts'][0] == {'candidate': 'origin', 'outcome': 'http', 'httpStatus': 404, 'error': 'HTTPError'}
        # Mirror first but a day behind: exactly one credentialed origin request.
        publish('mirror.zip', yesterday)
        publish('origin.zip', today)
        state = work / 'mirror-first-state'
        result = gtfs.prepare(recipe('mirrorfirst', **credentialed), state, validator=validator)
        retrieval = result['feeds'][0]['retrieval']
        assert retrieval['candidate']['kind'] == 'origin' and retrieval['freshness']['ageDays'] == 0
        assert len((budget / 'ACCEPTANCE_KEY.ledger').read_text().splitlines()) == 1
        # Budget spent and no floor: the stale mirror is used and flagged.
        result = gtfs.prepare(recipe('mirrorfirst', **credentialed), work / 'fresh-state', validator=validator)
        retrieval = result['feeds'][0]['retrieval']
        assert retrieval['candidate']['kind'] == 'mirror' and retrieval['freshness']['stale']
        assert [a['outcome'] for a in retrieval['attempts']] == ['accepted-stale', 'no-budget']
        assert any('budget' in w for w in retrieval['warnings'])
        # Same host state: the older mirror file is a regression and fails closed.
        pointer = (state / 'latest-validated.json').read_bytes()
        try:
            gtfs.prepare(recipe('mirrorfirst', **credentialed), state, validator=validator)
        except gtfs.SourceError as error:
            assert 'older than accepted' in str(error)
        else:
            raise AssertionError('mirror regression was accepted')
        assert (state / 'latest-validated.json').read_bytes() == pointer
        for path in work.rglob('*'):
            if path.is_file() and path.suffix in {'.json', '.ledger'}:
                assert 'acceptance-key' not in path.read_text(errors='replace'), path
    return {'originFailureUsesMirror': True, 'staleMirrorCostsOneOriginRequest': True,
            'budgetExhaustedUsesStaleMirror': True, 'mirrorRegressionFailsClosed': True, 'noCredentialInState': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', required=True, type=Path)
    parser.add_argument('--validator', required=True, type=Path)
    args = parser.parse_args()
    verify(args.work.resolve(), args.validator.resolve())
