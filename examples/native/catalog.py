"""Public city descriptors generated from host configuration, never live health."""
import json
import math
from pathlib import Path
import re
import tempfile
from zoneinfo import ZoneInfo

PUBLIC_FIELDS = ('id', 'name', 'tz', 'center', 'bbox', 'transitSources', 'routeGroups',
                 'defaultExcludedModes', 'poiFetchMode', 'sharedMobility', 'poiCityIds')


def descriptor(config):
    city = config.get('city', 'vilnius')
    presets = json.loads(Path(__file__).with_name('city-presets.json').read_text())
    profile = config.get('cityMetadata')
    if profile is None:
        profile = next((p for p in presets if p['id'] == city), None)
    if not isinstance(profile, dict):
        raise ValueError('Custom city requires cityMetadata (name, center, bbox)')
    timezone = config.get('timezone', profile.get('tz'))
    if not isinstance(timezone, str):
        raise ValueError('Custom city requires an explicit timezone')
    result = {key: profile[key] for key in PUBLIC_FIELDS if key in profile}
    result.update(id=city, tz=timezone)
    if not isinstance(city, str) or not re.fullmatch(r'[a-z][a-z0-9-]*', city):
        raise ValueError('Invalid city ID')
    ZoneInfo(timezone)
    if not isinstance(result.get('name'), str) or not result['name'].strip():
        raise ValueError('City name is required')
    center, bbox = result['center'], result['bbox']
    for value, limit in [(center['lat'], 90), (center['lon'], 180),
                         (bbox['minLat'], 90), (bbox['maxLat'], 90),
                         (bbox['minLon'], 180), (bbox['maxLon'], 180)]:
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or abs(value) > limit:
            raise ValueError('Invalid city coordinates')
    if not (bbox['minLat'] <= center['lat'] <= bbox['maxLat'] and bbox['minLon'] <= center['lon'] <= bbox['maxLon']
            and bbox['minLat'] < bbox['maxLat'] and bbox['minLon'] < bbox['maxLon']):
        raise ValueError('City center must lie inside valid bounds')
    return result


def publish_catalog(configs, directory):
    cities = [descriptor(config) for config in configs]
    if not cities or len({city['id'] for city in cities}) != len(cities):
        raise ValueError('Catalog needs unique cities')
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / 'cities.json'
    with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as output:
        output.write(json.dumps({'schemaVersion': 2, 'cities': cities}, ensure_ascii=False) + '\n')
        pending = Path(output.name)
    pending.chmod(0o644)
    pending.replace(target)
