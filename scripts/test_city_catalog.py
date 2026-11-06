import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('catalog', Path(__file__).resolve().parents[1] / 'examples/native/catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class CatalogTests(unittest.TestCase):
    def custom(self):
        return {'city': 'custom', 'timezone': 'UTC', 'trustedKeys': ['private-config'],
                'cityMetadata': {'name': 'Custom', 'center': {'lat': 1, 'lon': 1},
                                 'bbox': {'minLat': 0, 'minLon': 0, 'maxLat': 2, 'maxLon': 2},
                                 'secret': 'do-not-publish'}}

    def test_arbitrary_city_metadata_and_private_field_filter(self):
        result = catalog.descriptor(self.custom())
        self.assertEqual(result['id'], 'custom')
        self.assertEqual(result['tz'], 'UTC')
        self.assertNotIn('trustedKeys', result)
        self.assertNotIn('secret', result)

    def test_presets_are_backend_inputs_not_a_restriction(self):
        result = catalog.descriptor({'city': 'vilnius'})
        self.assertEqual(result['name'], 'Vilnius')
        self.assertIn('sharedMobility', result)
        with self.assertRaises(ValueError):
            catalog.descriptor({'city': 'not-a-preset'})

    def test_multi_city_catalog_is_atomic_and_has_no_default(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            catalog.publish_catalog([{'city': 'vilnius'}, self.custom()], root)
            result = json.loads((root / 'cities.json').read_text())
            self.assertEqual([city['id'] for city in result['cities']], ['vilnius', 'custom'])
            self.assertNotIn('defaultCity', result)
            with self.assertRaises(ValueError):
                catalog.publish_catalog([self.custom(), self.custom()], root)
            self.assertEqual(json.loads((root / 'cities.json').read_text()), result)

    def test_invalid_bounds_fail_before_publication(self):
        config = self.custom()
        config['cityMetadata']['center']['lat'] = 60
        with self.assertRaises(ValueError):
            catalog.descriptor(config)
