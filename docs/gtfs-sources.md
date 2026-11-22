# GTFS sources and community recipes

PTN releases include `examples/native/gtfs.py`. It fetches live source data,
prepares and validates a complete city candidate, and records exact inputs.
Native `host.py refresh` and Docker use this same implementation. GitHub feed
releases are evidence/rollback snapshots; routine updates do not wait for them.

Choose exactly one input in the host configuration:

```json
{"gtfsURL": "https://publisher.example/gtfs.zip"}
```

or a reviewed community recipe from [pt-feeds](https://github.com/uerban/pt-feeds):

```json
{
  "city": "warsaw",
  "timezone": "Europe/Warsaw",
  "gtfsRecipe": {
    "url": "https://api.github.com/repos/uerban/pt-feeds/tarball/REVIEWED_FULL_COMMIT_SHA",
    "sha256": "REPLACE_WITH_SHA256_OF_THAT_ARCHIVE",
    "name": "warsaw"
  }
}
```

These are input fragments; retain the state directory, signed OSM source and
trusted keys from the native host configuration. Raw mode defaults to Vilnius
and Europe/Vilnius; specify both fields for another city. Recipe city/timezone
must match the host. `gtfsRecipe` replaces `gtfsURL`.

A recipe archive contains `recipes/<name>.json` and its Python transformations.
It is **trusted executable code**. Review a full repository commit, download its
archive through an authenticated connection, and record its SHA-256 before
configuring it. A branch name or an unverified checksum supplied by that same
recipe is not an approval mechanism. Recipe changes are manually promoted;
source GTFS bytes continue refreshing independently. A verified pinned recipe
archive is reused locally; routine refreshes do not depend on GitHub availability.

For the currently private repository, native refresh can read `PT_FEEDS_TOKEN`
from its environment. The token is used only for archive requests to
`api.github.com` and removed on cross-host redirects. It is never sent to GTFS
publishers. Do not put credentials in URLs or configuration files.

Alternatively, fetch the reviewed archive on an administrator machine:

```sh
gh api repos/uerban/pt-feeds/tarball/REVIEWED_FULL_COMMIT_SHA > pt-feeds.tar.gz
sha256sum pt-feeds.tar.gz
```

Replace the recipe `url` with `"archive": "/absolute/path/pt-feeds.tar.gz"`, retaining
its `sha256` and `name`. For Docker, put it in the existing read-only configuration
mount and use `/config/pt-feeds.tar.gz`. No Git client or GitHub token is then
needed in the runtime container. Do not copy operator captures or signing keys
into this archive.

## Run and validate

Refresh/preparation requires Python 3.9+, timezone data, a trusted system CA
bundle, and Java 21+. The Docker host image includes these dependencies.
The canonical MobilityData validator 8.0.1 is downloaded once from its official
release and checked against the pinned SHA-256. To supply it offline, set
`gtfsValidatorJar` to an absolute path in host configuration; the same checksum
is mandatory. This validator uses up to 4 GiB heap. Prepare on a suitably sized
worker if the serving machine cannot run Java 21 or has insufficient memory;
CPU-compatible archives alone do not establish preparation capacity on ARMv6.

Prepare without changing serving data or installing OSM:

```sh
python3 examples/native/gtfs.py --config /absolute/config.json \
  --state /absolute/feed-work --validator /absolute/gtfs-validator-8.0.1-cli.jar
```

Omit `--validator` to download the pinned validator. The command prints a
manifest only after all required components pass. It exits nonzero on failure.
Use `host.py refresh` to also install OSM and invoke the matching producer.
The reference frontend/proxy remains Vilnius-specific; a successful recipe
check does not register another city in the PWA or establish hosting acceptance.

Every attempt retains raw ZIPs, retrieval times/URLs/HTTP validators, source and
prepared hashes, transformation code/logs, preparation evidence and canonical
reports. Original-feed validation is informational when bytes change. Prepared
canonical errors and validator failures block the candidate. Calendar additions
and removals are applied: every required component must have some service in
the next seven local dates, and their city union must cover all seven dates.
See the [GTFS calendar specification](https://gtfs.org/documentation/schedule/reference/#calendar_datestxt).

Conditional GETs reuse raw bytes only after checking their hash. Unchanged
source bytes and recipe/runtime code can reuse hash-verified preparation
outputs; coverage and prepared canonical validation still run again. An
unchanged download never exempts an expired timetable. No stale-cache fallback
is accepted when a publisher is unavailable. Downloads are capped at 256 MiB;
GTFS expanded size is capped at 2 GiB. Unknown transformation input shapes fail
for review rather than receive speculative repairs.

`latest-validated.json` identifies the latest validated feed candidate; it is
not the serving-generation pointer. The producer builds a full generation and
uses its existing atomic publication protocol. Fetch, preparation or quality
failure never invokes the producer. Serving-generation rollback remains the
producer/ops responsibility.

## Multiple feeds and source-specific behavior

Kraków requires A/M/T components; Tricity requires Gdańsk/Gdynia/SKM. The recipe
retains component order and each file separately. Before the producer's union,
PTN prefixes supported GTFS IDs and their references with `<sourceId>:`. Stop
codes, coordinates, times, repeated stop occurrences and sequence values remain
unchanged. The namespace rewrite rejects unreviewed tables or ID columns.
`pt-producer republish` accepts repeated `--from-cache` arguments and publishes
all components together. Source-aware realtime ID conversion is separate;
`host.py` rejects an unscoped `tripUpdatesURL` or `serviceAlertsURL` for
namespaced multi-feed inputs.

Warsaw runs normalization, lossless compaction, and its independent full-date
schedule/alias verifier. Its recipe requires `--derive-inseat off`. Alias and
running-board evidence stays on the worker, outside the PWA payload.

Riga discovers the newest monthly schedule from the official data.gov.lv CKAN
dataset by the export's month/year, not resource modification time. Discovery
JSON is retained. The explicit unnamed-column workaround still fails on an
unrecognized export; no dated September URL is silently reused as latest.

Tbilisi requires `TTC_API_KEY`, captures fresh TTC metro schedules each attempt,
and runs quoting normalization followed by the capture-bound metro repair and
its direction/timetable contract. Community bytes alone cannot bypass this
step. The composed recipe still needs a real authenticated acceptance run.

## Mirrors, freshness and request budgets

Recipe `schemaVersion` 2 lets a source name one mirror next to its publisher
`url` (the origin). Older runtimes refuse schema 2 recipes, so upgrade the
runtime before the recipe pin. Schema 1 recipes fetch as before, but for every
schema, steps and the validator no longer see `PT_FEEDS_TOKEN` or host
`credentials`, and `requiredEnvironment` cannot name them.

```json
{
  "id": "example",
  "url": "https://publisher.example/gtfs.zip",
  "auth": {"queryParam": "key", "env": "EXAMPLE_API_KEY"},
  "budget": {"requests": 40, "days": 30},
  "mirror": {"operator": "Mirror operator", "url": "https://mirror.example/latest.zip"},
  "prefer": "mirror",
  "freshness": {"signal": "feed_info.feed_version", "format": "%Y-%m-%d", "maxAgeDays": 0},
  "identity": {"feedInfo": {"feed_id": "EX"}, "agencyNames": ["Example Transit"], "agencyCount": 1}
}
```

- `prefer` (`origin` by default) picks which candidate is tried first. The
  other is the fallback. A mirror needs `identity`, and a mirror-first source
  also needs `freshness`. Attribution and terms
  always belong to the publisher, never to the mirror.
- Fallback on DNS, connection and timeout failures, truncated bodies, HTTP 5xx,
  400, 401, 403, 404, 408, 410 and 429, a dropped TLS connection, a response that is not a
  readable GTFS ZIP, and a credentialed redirect to another host. Certificate
  failures and HTTPS-downgrade redirects on the origin stop the source; on the
  mirror they only skip it.
- `identity` and `freshness` are read leniently from the raw download, before
  recipe steps (ragged rows and odd bytes are tolerated). A mirror whose
  `feed_info` or agencies differ from `identity`, or cannot be read at all, is
  skipped. The origin failing either stops the source: the feed itself
  changed.
- `freshness` reads `feed_info.feed_version` as a date and compares it with the
  local date in the recipe timezone. `maxAgeDays: 0` means today's version. A
  stale candidate is skipped; when every candidate is stale, the freshest valid
  one is used and `retrieval.json` marks it `stale`. A mirror without a
  readable version is skipped; an origin without one is accepted with a warning.
- A mirror file older than the last accepted version is skipped (sources with
  `freshness` only; without it, an origin-first mirror is bounded by identity
  and the seven-day coverage rule). If no other
  candidate is usable, the city fails and keeps the previous candidate. The
  floor is the newer of `latest-validated.json` (its version, or the floor it
  was checked against when it had none) and `freshnessFloors`
  (`{"<sourceId>": "YYYY-MM-DD"}`) in the host configuration, so a configured
  floor can raise it but never lower it. Origin data is authoritative and only
  warns.
- `auth` adds the named environment variable as a query parameter on origin
  requests only, and only when the host configuration lists that name in
  `credentials` (`["EXAMPLE_API_KEY"]`); otherwise the origin is skipped with a
  warning. Runtime names (`PT_FEEDS_*`, `PTN_*`, `GITHUB_TOKEN`, `GH_TOKEN`,
  `HOME`, `PATH`, `SSH_AUTH_SOCK`) are refused, and so is an origin URL that
  already sets the parameter. An `auth.env` is hidden from transformation
  steps, so it cannot also be in `requiredEnvironment`. It is never written to caches, metadata, results, failures or
  logs, is removed (with `PT_FEEDS_TOKEN` and every name in the host
  `credentials`) from the environment of transformation steps and the validator, and is not sent across a cross-host redirect. Values must match
  `[A-Za-z0-9._~-]{8,256}`; a missing or malformed value skips the origin.
- `budget` (`days` at most 400) counts origin requests per `auth.env` name before they are sent,
  including failures and HTTP 304. Each source counts only its own window, and
  the ledger keeps 400 days of history, so sources that share a credential
  with different windows never erase each other's requests. The ledger lives in `PT_FEEDS_BUDGET_DIR`
  (default `<state>/budget`); share one directory between all cities that use
  the same credential, and give one key one env name everywhere. Manual and dry
  runs spend the same budget.
- A source with a `mirror` must have service on each of the next seven days
  by itself, so a stale mirror cannot hide behind other components. Other
  sources keep the schema 1 rule. Schema 1 recipes refuse every schema 2 key.
- `retrieval.json` records `candidate`, every `attempts` outcome (no URLs),
  `freshness`, `floor` and `warnings`.

The first run after upgrading the runtime prepares every source again, because
reuse is bound to the runtime checksum.

## Change history

After every successful publication the host keeps a copy of the published
feeds in `<stateDirectory>/feeds/published/` and compares the next validated
candidate with them. The result is printed by `refresh` and, when the bytes
differ, appended to `<stateDirectory>/feeds/change-history.jsonl` (the last
1000 lines are kept). Each line holds, per source: old and new hashes and
sizes, the last service date, and for `stops`, `routes`, `trips` and
`stop_times` the number of added, removed and changed entries with a
percentage of the previous count. `stop_times` is counted per trip. The
headline `changePercent` is the largest of the four.

Rows are compared by GTFS ID and column name, so reordered columns or rows are
not a change. A publisher that renumbers its trip IDs on every export shows
close to 200% for trips (all removed, all added); read the stop and route
figures for such feeds. The first publication has no baseline and records
counts only. To compare two feeds by hand:

```sh
python3 examples/native/feed_change.py previous.zip current.zip
```

The history is a record. It does not block publication; the gates above do.
Prebuilt transit packs have no feed bytes on the host and record nothing.

## Pinning

`host.py pin --reason TEXT [--hours N]` holds publication for a bounded time
(default 24 hours, maximum 168); `unpin` releases it and `pin-status` shows
it. A pinned `refresh` still fetches, validates and prints the change against
the published feeds, then stops before the producer. In prebuilt mode a pinned
`refresh` skips the pack sync. See the native guide for when to use it.

## Cadence and retention

`refresh-loop` defaults to hourly polling. `refreshIntervalSeconds` configures
that interval (minimum 60); pt-ops owns the deployment-specific cadence and
alerts. An unchanged raw hash avoids rerunning transformations. OSM catalogs
have their own controlled publication cadence; GTFS fetching does not build OSM.

Default feed retention is three successful and three failed attempts, including
the latest validated candidate. `retainedFeedAttempts` adjusts each limit
(minimum two). Only tool-marked attempt directories are pruned. Superseded raw
cache objects are removed after attempts finish; retained attempts contain their
own exact source bytes. Producer generation retention is separate. Monitor free
space and refresh failures; large regional inputs still need measured budgets.
Long-term incident evidence must be exported before this rolling retention.
