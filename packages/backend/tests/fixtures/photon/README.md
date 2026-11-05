# Photon Synthetic ES Fixture

Synthetic Elasticsearch documents for Photon geocoder CI testing. These replace a real OSM data import, keeping the CI geocoder-integration job under 1 minute for the Photon path.

## Schema

Documents follow the Photon ES `photon` index schema (see [komoot/photon IndexMapping.java](https://github.com/komoot/photon/blob/master/src/main/java/de/komoot/photon/opensearch/IndexMapping.java)).

Key fields per document:

| Field | Type | Description |
|-------|------|-------------|
| `osm_id` | number | OpenStreetMap ID |
| `osm_type` | string | N (node), W (way), R (relation) |
| `osm_key` | string | OSM tag key (e.g. `railway`, `amenity`) |
| `osm_value` | string | OSM tag value (e.g. `station`, `hospital`) |
| `type` | string | Address type: `city`, `locality`, `street`, `house` |
| `importance` | float | Ranking score 0–1 |
| `coordinate` | object | `{ "lat": number, "lon": number }` |
| `name` | object | Localised names: `{ "default": "...", "en": "..." }` |
| `street` | object | Street name (localised) |
| `city` | object | City name (localised) |
| `state` | object | State/region (localised) |
| `country` | object | Country name (localised) |
| `countrycode` | string | ISO 3166-1 alpha-2 |
| `postcode` | string | Postal code |
| `housenumber` | string | House number (optional) |
| `collector` | object | Pre-computed search index fields |

## Coverage

The fixture contains 24 documents covering:

- **Cities:** Gdańsk, Gdynia, Sopot (Tricity), Vilnius
- **Train stations:** Gdańsk Główny, Gdynia Główna, Sopot, Vilnius Railway Station, Gdańsk Oliwa, Gdańsk Wrzeszcz
- **Hospitals:** Uniwersyteckie Centrum Kliniczne (Gdańsk), Vilnius University Hospital
- **Universities:** Politechnika Gdańska, Vilnius University
- **Streets:** Długa (Gdańsk), Geležinkelio gatvė (Vilnius)
- **Addresses:** Długa 47, Długa 12, Geležinkelio 6
- **POIs:** Sopot Pier, Biedronka (Sopot), Café Latte (Gdańsk), Dworzec Główny PKP

CI smoke queries target: `"Dworzec Główny"`, `"Vilnius"`, `"Sopot"` — all covered.

## How to use in CI

```bash
# Wait for ES to be ready
until curl -sf http://localhost:9200/_cluster/health?wait_for_status=yellow; do sleep 2; done

# Create the photon index (Photon creates it on startup, but for fixture-only mode):
curl -sf -XPUT 'http://localhost:9200/photon'

# Bulk-index the fixtures
curl -sf -XPOST 'http://localhost:9200/photon/_bulk' \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @packages/backend/tests/fixtures/photon/bulk-index.ndjson

# Refresh the index so documents are searchable
curl -sf -XPOST 'http://localhost:9200/photon/_refresh'
```

## Adding or modifying fixtures

1. Each document is two NDJSON lines: an action line (`{"index": ...}`) and the document body.
2. Use realistic coordinates — the `coordinate` field is a geo_point and ES validates it.
3. The `collector` object powers full-text search. Its `all` field should contain all searchable text space-separated. The `name` field contains just the place names. The `field` sub-object maps address component names to arrays of their values.
4. The `_id` in the action line should follow the pattern `{osm_type}{osm_id}` (e.g. `N1234567`).
5. After editing, verify the file has an even number of lines (pairs of action + document).
6. Test locally with: `wc -l bulk-index.ndjson` — should be even.
