"""Materialize a small reproducible stop-level corpus from retained inputs."""
import argparse
from bisect import insort
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform

import ledger
from ledger import canonical, fingerprint, validate_plan
from runner import artifact, settings_check, sha


class Draws:
    """Versioned SHA-256 counter stream with unbiased bounded-integer mapping."""
    def __init__(self, domain):
        self.domain = canonical(domain).encode()
        self.counter = 0

    def below(self, bound):
        if type(bound) is not int or not 0 < bound < 2 ** 256:
            raise ValueError('Invalid draw population')
        ceiling = 2 ** 256 - (2 ** 256 % bound)
        for _ in range(128):
            data = hashlib.sha256(self.domain + b'\0' + str(self.counter).encode()).digest()
            self.counter += 1
            value = int.from_bytes(data, 'big')
            if value < ceiling:
                return value % bound
        raise ValueError('Seeded draw exceeded rejection bound')


def query_for(origin, destination, stratum):
    return {'entryStops': [{'stopId': origin, 'walkSecs': 0}], 'exitStops': [{'stopId': destination, 'walkSecs': 0}],
            'date': stratum['date'], 'departureSecs': stratum['departureSecs'],
            'mobilityProfile': stratum['mobilityProfile'], 'maxRounds': stratum['maxRounds']}


def materialize_plan(store, run_id):
    if not run_id or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for char in run_id):
        raise ValueError('Invalid source run ID')
    manifest_bytes = (Path(store) / 'runs' / f'{run_id}.json').read_bytes()
    source = json.loads(manifest_bytes)
    if source.get('schemaVersion') != 1 or source.get('completion') != 'success':
        raise ValueError('Sampling requires a successful retained source capture')
    values = {name: artifact(store, digest) for name, digest in source['artifacts'].items()}
    for name, path in [('samplingGeneratorSource', Path(__file__)), ('samplingGeneratorLedger', Path(ledger.__file__))]:
        if values.get(name) != path.read_bytes():
            raise ValueError(f'Retained generator source mismatch: {name}')
    universe = json.loads(values['samplingStopUniverse'])
    spec = json.loads(values['samplingSpec'])
    if not isinstance(universe, dict) or universe.get('format') != 'ptn-search-stop-universe' or universe.get('version') != 1:
        raise ValueError('Unsupported stop universe')
    if universe.get('ptbSha256') != source['artifacts']['ptb']:
        raise ValueError('Stop universe belongs to another PTB')
    if not isinstance(spec, dict) or spec.get('format') != 'ptn-search-sampling-spec' or spec.get('version') != 1:
        raise ValueError('Unsupported sampling specification')
    if not isinstance(spec.get('seed'), str) or not spec['seed'].strip() or not isinstance(spec.get('timezone'), str) or not spec['timezone'].strip():
        raise ValueError('Sampling seed and timezone required')
    limits = spec.get('limits')
    if not isinstance(limits, dict) or type(limits.get('maxJobs')) is not int or not 1 <= limits['maxJobs'] <= 50:
        raise ValueError('Explicit small pilot job limit required')
    bounds = spec.get('bounds', {})
    if not all(type(bounds.get(key)) in (int, float) and math.isfinite(bounds[key]) for key in ('south', 'west', 'north', 'east')):
        raise ValueError('Explicit finite rectangular bounds required')
    if not (-90 <= bounds['south'] < bounds['north'] <= 90 and -180 <= bounds['west'] < bounds['east'] <= 180):
        raise ValueError('Invalid rectangle; antimeridian bounds are unsupported')
    rows = universe.get('stops')
    if not isinstance(rows, list) or len(rows) > 50000:
        raise ValueError('Invalid or oversized stop universe')
    population, seen = [], set()
    for stop in rows:
        if not isinstance(stop, dict):
            raise ValueError('Invalid compiled stop row')
        identity, lat, lon = stop.get('stopId'), stop.get('latE7'), stop.get('lonE7')
        if not isinstance(identity, str) or not identity.strip() or identity in seen:
            raise ValueError('Invalid or duplicate compiled stop ID')
        if type(lat) is not int or type(lon) is not int or not -900000000 <= lat <= 900000000 or not -1800000000 <= lon <= 1800000000:
            raise ValueError('Invalid compiled E7 coordinate')
        seen.add(identity)
        if bounds['south'] <= lat / 1e7 <= bounds['north'] and bounds['west'] <= lon / 1e7 <= bounds['east']:
            population.append(identity)
    population.sort(key=lambda value: value.encode('utf-8'))
    if len(population) < 2:
        raise ValueError('At least two compiled stops must be inside the rectangle')
    strata = spec.get('strata')
    if not isinstance(strata, list) or not 1 <= len(strata) <= 50:
        raise ValueError('Explicit bounded strata required')
    jobs, query_keys, control_indices = [], set(), spec.get('reportedTupleIndices', [])
    if not isinstance(control_indices, list) or not all(type(index) is int for index in control_indices) or len(set(control_indices)) != len(control_indices):
        raise ValueError('Invalid control tuple indices')
    tuples = source.get('report', {}).get('tuples', [])
    for index in control_indices:
        if type(index) is not int or not 0 <= index < len(tuples):
            raise ValueError('Control tuple outside retained source')
        query = tuples[index]['query']
        jobs.append({'query': query, 'stratum': f'retained-control-{index}', 'partition': 'reported', 'sourceTupleIndex': index})
        query_keys.add(canonical(query))
    total = len(jobs)
    ids, conditions = set(), set()
    for stratum in strata:
        if not isinstance(stratum, dict):
            raise ValueError('Invalid stratum')
        identity = stratum.get('id')
        if not isinstance(identity, str) or not identity.strip() or identity in ids:
            raise ValueError('Unique stratum identifiers required')
        ids.add(identity)
        date = stratum.get('date')
        if not isinstance(date, str) or len(date) != 8 or not date.isascii() or not date.isdigit():
            raise ValueError('Invalid service date')
        datetime.strptime(date, '%Y%m%d')
        if type(stratum.get('departureSecs')) is not int or not 0 <= stratum['departureSecs'] <= 172800:
            raise ValueError('Invalid fixed departure seconds')
        if stratum.get('mobilityProfile') not in ('default', 'wheelchair', 'bicycle'):
            raise ValueError('Unsupported engine mobility profile')
        if type(stratum.get('maxRounds')) is not int or not 1 <= stratum['maxRounds'] <= 4:
            raise ValueError('Sampling stays within the current four-round default')
        condition = canonical({key: stratum[key] for key in ('date', 'departureSecs', 'mobilityProfile', 'maxRounds')})
        if condition in conditions:
            raise ValueError('Duplicate query stratum')
        conditions.add(condition)
        for partition in ('random', 'holdout'):
            if type(stratum.get(partition)) is not int or not 0 <= stratum[partition] <= 50:
                raise ValueError('Invalid per-stratum sample count')
            total += stratum[partition]
    if total > min(50, spec['limits']['maxJobs']) or not any(s['random'] for s in strata) or not any(s['holdout'] for s in strata):
        raise ValueError('Sample budget exceeded or random/holdout partition absent')
    count = len(population)
    positions = {identity: index for index, identity in enumerate(population)}
    population_hash = fingerprint(population)
    diagnostics = []
    for stratum in strata:
        excluded = set()
        for job in jobs:
            query = job['query']
            if len(query.get('entryStops', [])) == 1 and len(query.get('exitStops', [])) == 1:
                origin, destination = query['entryStops'][0]['stopId'], query['exitStops'][0]['stopId']
                if origin in positions and destination in positions and origin != destination and canonical(query_for(origin, destination, stratum)) == canonical(query):
                    a, b = positions[origin], positions[destination]
                    excluded.add(a * (count - 1) + b - (b > a))
        omitted = sorted(excluded)
        available = count * (count - 1) - len(omitted)
        if stratum['random'] + stratum['holdout'] > available:
            raise ValueError('Requested unique pairs exceed the eligible population')
        diagnostics.append({'id': stratum['id'], 'eligibleOrderedPairs': available,
                            'excludedExactQueries': len(omitted), 'random': stratum['random'], 'holdout': stratum['holdout']})
        for partition in ('random', 'holdout'):
            draws = Draws({'algorithm': 1, 'seed': spec['seed'], 'population': population_hash, 'stratum': {key: stratum[key] for key in ('id', 'date', 'departureSecs', 'mobilityProfile', 'maxRounds')}, 'partition': partition})
            for _ in range(stratum[partition]):
                index = draws.below(count * (count - 1) - len(omitted))
                for skip in omitted:
                    if skip <= index:
                        index += 1
                    else:
                        break
                insort(omitted, index)
                a, b = divmod(index, count - 1)
                b += b >= a
                query = query_for(population[a], population[b], stratum)
                if canonical(query) in query_keys:
                    raise ValueError('Sampling would duplicate a materialized query')
                query_keys.add(canonical(query))
                jobs.append({'query': query, 'stratum': stratum['id'], 'partition': partition})
    plan = {'format': 'ptn-search-pilot', 'version': 1, 'seed': spec['seed'], 'timezone': spec['timezone'],
            'artifacts': source['artifacts'], 'settings': spec['settings'], 'limits': spec['limits'], 'jobs': jobs,
            'sampling': {'version': 1, 'algorithm': 'sha256-rank-without-replacement-v1',
                         'sourceManifestSha256': sha(manifest_bytes), 'universeSha256': source['artifacts']['samplingStopUniverse'],
                         'specSha256': source['artifacts']['samplingSpec'], 'populationStopIdsSha256': population_hash,
                         'compiledStops': len(rows), 'insideRectangleStops': count, 'bounds': bounds, 'strata': diagnostics,
                         'pythonVersion': platform.python_version(),
                         'scope': 'uniform ordered distinct stop pairs per declared stratum, excluding exact materialized controls',
                         'holdoutPolicy': 'exact-query-disjoint; not a geographic or demand holdout',
                         'unsupported': ['door-to-door endpoints/access', 'uniform geography or demand', 'physical pedestrian reachability', 'representative city coverage']}}
    validate_plan(plan)
    settings_check(plan)
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('store', type=Path)
    parser.add_argument('source_run_id')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    plan = materialize_plan(args.store, args.source_run_id)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        output.write(canonical(plan) + '\n')
    print(canonical({'jobs': len(plan['jobs']), 'insideRectangleStops': plan['sampling']['insideRectangleStops']}))


if __name__ == '__main__':
    main()
