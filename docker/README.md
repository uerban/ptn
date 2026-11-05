# Reference Docker host

This runs the same release archive and Caddyfile as the
[native example](../examples/native/README.md). Only Vilnius is included.
There are no private registries, host-specific volumes, or legacy Node servers.
See [validation](../examples/VALIDATION.md) before treating a path as supported.

Use Docker Engine with Compose v2 or newer on Linux x86_64. Source image construction
uses BuildKit. Other runtimes and architectures need their own validation.

## Prepare the release and data

Build or download `ptn-linux-x86_64.tar.gz` and verify its checksum as described
in the native guide. Extract it under this checkout's `release/` directory:

```sh
mkdir -p release
tar -xzf /absolute/path/ptn-linux-x86_64.tar.gz -C release
```

Build a local OSM repository with the instructions in the extracted archive's
`examples/native/README.md`. This is a one-time data build, separate from the
running containers. Preserve the builder's private key outside the deployment.

Create an absolute configuration directory and copy
`examples/native/config.example.json` into it as `config.json`. Set:

- `stateDirectory`: `/var/lib/ptn`
- `listenAddress`: `0.0.0.0:9000`
- `auxAddress`: `0.0.0.0:9001`
- `artifactSource`: `{"kind":"local","directory":"/osm-repository"}`
- `trustedKeys`: the public key from the local builder's `artifact-source.json`

Set these variables in each shell used for Compose:

```sh
export PTN_CONFIG_DIR=/absolute/path/to/config-directory
export PTN_OSM_REPOSITORY=/absolute/path/to/osm-build/repository
```

## Localhost

From the source checkout root:

```sh
docker compose -f docker/compose.yml build transit
docker compose -f docker/compose.yml run --rm transit refresh
docker compose -f docker/compose.yml up -d
curl --fail http://localhost:8080/api/vilnius/ready
```

Open <http://localhost:8080> in a fresh browser profile and search between two
stops after synchronization. The updater refreshes GTFS and the installed OSM
catalog hourly; rebuild your local OSM catalog separately when needed.

## Public HTTPS

Configure public DNS and inbound ports as described in the native guide, then:

```sh
export PTN_DOMAIN=transit.example.org
docker compose -f docker/compose.yml -f docker/compose.https.yml up -d
curl --fail "https://$PTN_DOMAIN/api/vilnius/ready"
```

Keep the `caddy-data` volume: it stores certificate state. Only the web server
publishes ports. Transit, metrics and the internal departure listener stay on
the container network. The inherited 8080 host binding remains loopback-only.

Use the same `-f` arguments for logs, restart and shutdown. Retain the volumes:
`down -v` deletes transit data and certificate state. To inspect a failed
startup, use `docker compose -f docker/compose.yml logs --tail 100`.

The host image includes Java 21 and timezone data for mandatory GTFS validation.
Its configuration accepts a raw publisher URL or a checksum-pinned community
recipe; see [GTFS sources and refresh](../docs/gtfs-sources.md). For a private
recipe repository, a reviewed archive can be placed in the existing configuration
mount so no GitHub credential is needed in the containers.
