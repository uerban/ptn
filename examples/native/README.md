# One-city native host

This reference setup serves Vilnius with the PWA, local transit planning,
walking transfers, addresses, managed POIs, and GTFS realtime updates.
Use the matching binaries and web assets from one archive. See
[release platforms](../../docs/release-platforms.md) in the source repository
for the Linux and macOS matrix, and [validation](../VALIDATION.md) for checks
and limitations. `v0.1.0` provides Linux x86_64 only.

Runtime requirements: Python 3.9+, timezone data, a system CA bundle, Java 21+
for feed validation, and Caddy 2.11.7.
Building your own OSM catalog additionally needs Node 22.22+ and osmium-tool.
Rust, pnpm, node_modules, and a source checkout are not needed on a release host.
The third-party MOTIS/OTP adapter and other cities are outside this example.

## Obtain the installation

Choose an explicit release tag and an archive platform listed on that release
(replace `vX.Y.Z`). The example below uses Linux x86_64. Other platform names
are `linux-armv6-rpi1`, `linux-aarch64-rpi3`, `darwin-arm64`, and
`darwin-x86_64`:

```sh
VERSION=vX.Y.Z
PLATFORM=linux-x86_64
curl --fail --location --remote-name "https://github.com/uerban/ptn/releases/download/$VERSION/ptn-$PLATFORM.tar.gz"
curl --fail --location --remote-name "https://github.com/uerban/ptn/releases/download/$VERSION/ptn-$PLATFORM.tar.gz.sha256"
sha256sum --check "ptn-$PLATFORM.tar.gz.sha256"
tar -xzf "ptn-$PLATFORM.tar.gz"
cd "ptn-$PLATFORM"
sha256sum --check SHA256SUMS
```

On macOS, use `shasum -a 256 --check` in place of `sha256sum --check`.
To build an archive yourself, use the
[source build instructions](https://github.com/uerban/ptn#build).
The extracted archive has the same layout. Checksums
detect corruption; obtain the archive and checksum from the intended release.

## Prepare OSM data locally

On ARMv6 boards, prepare OSM data on a larger host, then copy the signed
repository and public trust configuration to the board. Node 22 is not an
ARMv6 runtime option. A small board may also lack enough memory for a full
city build; the archive's CPU compatibility does not establish a memory budget.

From the extracted archive, choose a separate private working directory:

```sh
node examples/native/prepare-osm.mjs "$PWD/../osm-build"
PT_ADDRESS_EXTRACT_SCRIPT="$PWD/builder/packages/backend/scripts/extract-addr-fixture.mjs" \
  node builder/packages/backend/src/poi/buildArtifacts.mjs "$PWD/../osm-build/builder.json"
```

The builder downloads the Lithuania extract over HTTPS, creates the city
walking graph, addresses and POIs, validates and signs a catalog, and writes
`../osm-build/repository`. It needs space for the extract and intermediate
files. A missing or failed required component prevents host initialization.

Preserve `osm-build/signing-key.pem` privately for future updates. The host
needs only the repository and the public key from `artifact-source.json`.
Never copy the signing key into a web root or a runtime container.

## Initialize a fresh host

Copy `examples/native/config.example.json` to a working `config.json` outside
the archive. Replace its `artifactSource` and `trustedKeys` with the values in
`osm-build/artifact-source.json`. Keep the local repository directory absolute.
Set `stateDirectory` to an absolute writable directory such as `/var/lib/ptn`.
Set `dataRootId` to a unique identity for this deployment and city, such as
`release-3:vilnius`. Keep it unchanged across restarts and restores of this
deployment; use a different identity for an isolated candidate deployment.
For a downloaded signed catalog, use `{"kind":"https","url":"https://your-data-host"}`
and its public signing key instead. No private staging source is used.

```sh
python3 examples/native/host.py --config /absolute/path/config.json refresh
python3 examples/native/host.py --config /absolute/path/config.json serve
```

The first command installs and verifies OSM artifacts, downloads the current
GTFS feed, validates its canonical GTFS and upcoming service coverage, obtains the reader-version sentinel from the matching server, then
publishes a complete generation. It explicitly selects the Rust color and
schedule-tile builders, so generation publishing needs no Node helper.

### Existing state and mount identity

New configurations bind the transit directory to `dataRootId`. The host passes
that identity to both native binaries as `PT_DATA_ROOT_ID`. They verify the
stored `.data-root-identity.json` against configuration, independently of Linux
device numbers and directory inodes, which can change after reboot or restore.
An already bound reader starts without running or locking the producer.

For an existing unbound root, stop its producer and reader, verify its mount and
the accepted generation against your deployment record, then explicitly bind it
using the matching new producer binary:

```sh
bin/pt-producer bind-data-root --data-root /var/lib/ptn/transit \
  --identity release-3:vilnius --expected-generation ACCEPTED_64_HEX_GENERATION
```

Set `dataRootId` to the same identity in the private host configuration and
restart the reader. Binding checks the pinned current generation and changes
only the identity marker, without fetching feeds or rebuilding generations.
It refuses to overwrite another identity. Normal startup cannot migrate a
populated unbound root. Keep the legacy `.producer-data-root-id` file intact;
the new verifier ignores its device/inode comparison for a valid bound root.

When invoking binaries directly, set `PT_DATA_ROOT_ID` consistently on every
reader and producer command. Missing configuration, missing/corrupt identity,
and mismatched identity fail closed for configured roots. Configurations that
omit the identity retain the legacy guard and need migration to gain remount
recovery. Older binaries still use the legacy guard, so use a matching new
release for both processes. A cloned root with the same identity is the same
logical dataset; the marker does not prove producer liveness or freshness.
Monitor generation adoption and freshness separately.

Leave the second command running. It binds transit and auxiliary listeners to
loopback. In another terminal, start the web server from the extracted archive:

```sh
PTN_SITE=http://localhost:8080 \
PTN_WEB_ROOT="$PWD/web" \
PTN_ARTIFACT_PUBLIC=/absolute/state/directory/artifacts/public \
  caddy run --config /var/lib/ptn/public-config/Caddyfile --adapter caddyfile
```

Open <http://localhost:8080> in a fresh browser profile. Allow the initial city
sync to finish, then search between two stops. A missing asset or API returns
an error rather than the SPA document. Metrics and the internal departure
listener are not exposed by this proxy. The base map may use its configured
external tile service; transit queries run on the device.

See [GTFS sources and recipes](../../docs/gtfs-sources.md) for direct publisher
URLs, pinned community preparation, evidence, cadence and retention. The
preparation command supports additional cities; this PWA/proxy example remains
Vilnius-specific.

## Public HTTPS

Use the same Caddyfile and paths, setting `PTN_SITE=transit.example.org` to your
own DNS name. Point its A record (and any AAAA record) at this host, allow
inbound TCP 80/443, and keep Caddy's data directory persistent and writable.
Caddy obtains and renews a public certificate and redirects HTTP to HTTPS.
Do not expose ports 9000–9002 on the host firewall.

[Caddy's HTTPS prerequisites](https://caddyserver.com/docs/automatic-https)
apply. A local-CA TLS test does not prove that your public DNS, firewall, or
ACME issuance works; check the final public URL with a normal browser and
`curl --fail https://transit.example.org/api/vilnius/ready` without bypassing TLS.

The Caddyfile sends `Referrer-Policy: strict-origin`, because page addresses
can name stops, lines and coordinates. If you serve the web archive through a
different proxy, set the same header there so those addresses are never
forwarded to other sites.

## Live departures and service alerts

`tripUpdatesURL` enables live departure times from a GTFS-RT TripUpdates feed.
`serviceAlertsURL` (optional) enables service alerts from a GTFS-RT
ServiceAlerts feed; the server polls it once a minute. Without it the alerts
endpoint answers 404 and the app does not offer alerts for the city. Both
accept a comma-separated list of URLs and are not supported with multi-feed
recipes. The app asks the server for live times or alerts only after the
rider turns that service on.

## Updates and restart

Run `refresh` hourly using the same configuration. For a foreground process:

```sh
python3 examples/native/host.py --config /absolute/path/config.json refresh-loop
```

A failed artifact sync, download, or generation publish exits nonzero and
preserves the serving generation. The loop logs the failure and retries in an
hour. The server adopts published generations itself. Re-run the OSM builder
with the original `builder.json` when refreshing the local OSM catalog; the
host updater does not rebuild OSM. Retain the state directory across restarts.

Run the server, updater, and Caddy under your host's process supervisor for a
persistent deployment. No systemd or other supervisor template is included in
the initial example; those need separate lifecycle validation before shipping.

## City discovery and custom cities

The host publishes its configured city descriptor at `/api/cities`; the web
archive discovers it before starting transit services. There is no default
city: first launch offers a city list and optional location lookup.

`refresh` and `serve` write the catalog and city-specific proxy configuration
to `<stateDirectory>/public-config/`. To generate them without downloading or
starting transit, run `host.py --config /absolute/path/config.json web-config`.
Use the generated Caddyfile with the same `PTN_WEB_ROOT`, `PTN_ARTIFACT_PUBLIC`,
`PTN_MAIN` and `PTN_AUX` environment as above. Replace `/var/lib/ptn` in the
command with your configured state directory when necessary.

For a custom city, set `city`, `timezone`, and `cityMetadata` with `name`,
`center` and `bbox`. Known entries in `city-presets.json` are optional
onboarding presets, not a restriction on supported cities. Optional
`countryCode` (ISO 3166-1 alpha-2, used to group and label cities in the
setup list), credits, route groups, excluded modes, POI mode and shared
mobility can be supplied explicitly in the metadata. Feed and signed OSM data still need to be prepared
for the configured city; this does not make the reference Vilnius OSM builder
a generic city builder.

Only public city metadata is emitted. Feed URLs, signing configuration and
internal addresses are not part of the catalog. Multi-city deployments can
use `catalog.publish_catalog(configs, output_directory)` with their accepted
city configurations and expose the resulting `cities.json` at `/api/cities`.
Catalog membership describes configured cities, independently of readiness.
