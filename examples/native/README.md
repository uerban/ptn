# One-city native host

This reference setup serves Vilnius with the PWA, local transit planning,
walking transfers, addresses, managed POIs, and GTFS realtime updates.
Use the matching binaries and web assets from one archive. The initial
release target is Linux x86_64. See [validation](../VALIDATION.md) for actual
checks and any release blockers.

Runtime requirements: Python 3.9+, a system CA bundle, and Caddy 2.11.7.
Building your own OSM catalog additionally needs Node 22.22+ and osmium-tool.
Rust, pnpm, node_modules, and a source checkout are not needed on a release host.
The third-party MOTIS/OTP adapter and other cities are outside this example.

## Obtain the installation

Once a release has been published, choose its explicit tag (replace `vX.Y.Z`):

```sh
VERSION=vX.Y.Z
curl --fail --location --remote-name "https://github.com/uerban/ptn/releases/download/$VERSION/ptn-linux-x86_64.tar.gz"
curl --fail --location --remote-name "https://github.com/uerban/ptn/releases/download/$VERSION/ptn-linux-x86_64.tar.gz.sha256"
sha256sum --check ptn-linux-x86_64.tar.gz.sha256
tar -xzf ptn-linux-x86_64.tar.gz
cd ptn-linux-x86_64
sha256sum --check SHA256SUMS
```

Before the first release exists, build and package using the
[source build instructions](https://github.com/uerban/ptn#build).
The extracted archive has the same layout. Checksums
detect corruption; obtain the archive and checksum from the intended release.

## Prepare OSM data locally

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
For a downloaded signed catalog, use `{"kind":"https","url":"https://your-data-host"}`
and its public signing key instead. No private staging source is used.

```sh
python3 examples/native/host.py --config /absolute/path/config.json refresh
python3 examples/native/host.py --config /absolute/path/config.json serve
```

The first command installs and verifies OSM artifacts, downloads the current
GTFS feed, obtains the reader-version sentinel from the matching server, then
publishes a complete generation. It explicitly selects the Rust color and
schedule-tile builders, so generation publishing needs no Node helper.

Leave the second command running. It binds transit and auxiliary listeners to
loopback. In another terminal, start the web server from the extracted archive:

```sh
PTN_SITE=http://localhost:8080 \
PTN_WEB_ROOT="$PWD/web" \
PTN_ARTIFACT_PUBLIC=/absolute/state/directory/artifacts/public \
  caddy run --config examples/native/Caddyfile --adapter caddyfile
```

Open <http://localhost:8080> in a fresh browser profile. Allow the initial city
sync to finish, then search between two stops. A missing asset or API returns
an error rather than the SPA document. Metrics and the internal departure
listener are not exposed by this proxy. The base map may use its configured
external tile service; transit queries run on the device.

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
