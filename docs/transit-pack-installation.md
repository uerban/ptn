# Installing transit selections

`pt-transit` installs signed prebuilt transit data without feed downloads,
Java, Node, producer execution or OSM extras. `pt-serve` can consume installed
selections directly. The [native host prebuilt mode](../examples/native/prebuilt.md)
provides a configuration-based install, serve and update loop.

```sh
cargo run -p pt-artifacts --locked --bin pt-transit -- \
  --root /srv/pt-data --city CITY --trusted-key PUBLIC_KEY_HEX \
  sync --source-url https://mirror.example/ --without-geometry
```

Release archives include these commands under `bin/` and this guide under
`docs/`. Add the extracted `bin/` directory to `PATH`; the installer and server
do not invoke the other builder tools bundled in the archive. Use binaries and
web assets from the same validated release.

Inspect signed served-city discovery and its available geometry choices before
installing:

```sh
pt-transit --root /srv/pt-data --trusted-key PUBLIC_KEY_HEX \
  cities --source-url https://mirror.example/
pt-transit --root /srv/pt-data --city CITY --trusted-key PUBLIC_KEY_HEX \
  sync --source-url https://mirror.example/ --from-discovery --without-geometry
```

`cities` does not require `--city`. Other commands do. `--from-discovery` installs
the exact immutable city head in the authenticated snapshot, including its
advertised selected file size. It does not chase a newer mutable city alias.
A city absent from discovery is not automatically installed or updated through
this mode. Omitting `--from-discovery` retains direct per-city head lookup for
older mirrors and explicit city operations.

The installer persists the highest authenticated discovery sequence/hash when it
accepts a list, separately from city installation state. A failed later download
does not undo that advertising checkpoint; the city's current selection and its
catalog checkpoint still change only after coherent installation succeeds. A
restarted installer rejects replayed or equivocating lists. Pinning a city makes
its sync return without fetching discovery. Listing cities can still refresh
discovery metadata. Removing a city from the advertised set does not remove its
installed files or prevent offline serving and explicit local rollback.

Use `--source-directory /path/to/repository` for an offline local mirror instead
of `--source-url`. Public keys come from operator configuration, not the mirror.
Repeat `--trusted-key` during key rotation. Omit `--without-geometry` to request
the full selection. An unavailable choice fails; it never silently changes the
selection. Both choices retain the publisher's pack ID.

The signed repository layout is:

```text
transit/catalog/v1/CITY/latest.json
transit/catalog/v1/CITY/latest.json.sig
transit/catalog/heads/HEAD_SHA256/latest.json.sig
transit/discovery/v1/latest.json
transit/discovery/heads/DISCOVERY_SHA256/latest.json.sig
transit/selections/DESCRIPTOR_SHA256/selection.json
transit/selections/DESCRIPTOR_SHA256/selection.json.sig
transit/objects/sha256/FILE_SHA256
```

This layout is the download contract. The [transit publisher](transit-pack-publication.md)
assembles accepted exports, maintains a sequence ledger and switches completed
heads atomically. Deployment, cache configuration and production acceptance are
separate work. Clients prefer the immutable head signature matching the exact
`latest.json` hash, with the mutable signature path retained for older mirrors.

The installer authenticates the catalog and selected descriptor, enforces
sequence/expiry checks and local resource limits, then streams each missing
object through the existing bounded hash/size verifier. Verified cache entries
are reused. It copies files into a new private staging tree and checks their
complete signed inventory and native formats before publishing an immutable
local release. Files are copied rather than hard-linked to prevent cache repair
or corruption in one release from changing another.

The installer owns `/srv/pt-data/transit`, with an exclusive writer lock. Its
atomic state contains the current selection, previous selection, monotonic local
revision, pin and catalog sequence/hash checkpoint. A failed download or
validation does not advance that state. Opening the store cleans owned
interrupted staging files. A complete release left by a crash before activation
is revalidated and reused on retry. OSM extras use their existing independent
store and activation policy.

Inspect state or revalidate the installed pack without contacting the mirror:

```sh
pt-transit --root /srv/pt-data --city CITY status
pt-transit --root /srv/pt-data --city CITY --trusted-key PUBLIC_KEY_HEX verify
```

`verify` prints the selected immutable `files/` directory after validation.
It does not write producer pointers. Start the server with an explicit installer
root and independently configured publisher keys:

```sh
pt-serve --transit-store-root /srv/pt-data --transit-trusted-key PUBLIC_KEY_HEX \
  --city-slug CITY --data-root /srv/pt-runtime --pidfile-path /srv/pt-runtime/serve.pid \
  --max-rss-bytes "$RSS_BUDGET_BYTES" \
  --process-fixed-overhead-bytes "$FIXED_OVERHEAD_BYTES" \
  --per-worker-overhead-bytes "$WORKER_OVERHEAD_BYTES" --page-warm-mode off
```

Create `/srv/pt-runtime` first and supply measured memory-budget values for the
host. It is a writable runtime directory, separate from the installer tree.
`PT_SERVE_TRANSIT_STORE_ROOT` and comma-separated `PT_SERVE_TRANSIT_TRUSTED_KEY`
are the corresponding environment settings. Repeat `--transit-trusted-key` for
rotation. The server requires trusted keys in installed mode and rejects
`--force-current`; use the installer's explicit rollback command instead.

Startup authenticates the current selection, compares every selected file to
its signed inventory, validates native data, and builds the routing index before
serving. This works offline and takes no installer lock. The server does not
clean staging, write installer state, read producer pointers, or advertise itself
to a producer in this mode. Legacy generation-local address-search data is not
loaded; OSM extras retain their independent configuration.

The reload watcher follows the installer activation file. SIGHUP also triggers
a check. Switching full/minimal variants reloads even when pack and generation
IDs match. Pin or checkpoint-only changes validate and become no-ops. A failed
update leaves the running generation in place. Invalid current data at startup
fails closed; repair it or run `pt-transit rollback` explicitly. There is no
implicit previous-selection fallback. Keep all installed releases immutable and
retained while serving, including generations held by in-flight requests.

A geometry-free installed selection always disables shapes loading, regardless
of the server's default. `pt-serve --without-geometry` (or
`PT_SERVE_WITHOUT_GEOMETRY=true`) can additionally suppress geometry in a full
selection. In that case the full signed selection still validates, including its
selected shapes; choose a minimal install to avoid those downloads and reads.
The runtime flag also works with producer data roots. It suppresses geometry
bodies and advertised hashes without rewriting publisher metadata or pack
identity. `--page-warm-mode off` separately avoids speculative page-in. These
flags do not change the installer selection.

To pause updates, use `pin`; use `unpin` to enable them again. `rollback` validates
and switches to the previous installed selection, preserves the highest accepted
catalog sequence/hash, and pins the result. A deliberate rollback can use an old
installed selection after its advertising head expires. Head expiry never
prevents continued offline validation/use. Configured keys must still trust the
installed descriptor. No automatic pruning is enabled.

The default local limits are 4 GiB per file, 8 GiB of selected file bytes and
100,000 files. `sync --max-file-bytes` and `--max-selected-bytes` can lower these
limits. They bound an individual install, not total disk consumption: cached
objects, staging and retained releases also need space. These are configurable
ceilings, not claims about minimum host memory or capacity.

## Docker installation

The transit installer has a separate scratch-image target containing the native
client and CA certificates. Build it and the server from the same reviewed
source revision on a builder with Docker BuildKit. These commands build local
images; they do not refer to a published image or a configured public mirror.
The server image currently targets Linux x86_64.

```sh
docker build --target transit -f docker/pt-artifacts.Dockerfile -t ptn-transit:local .
docker build -f docker/pt-serve.Dockerfile -t ptn-serve:local .
docker volume create ptn-transit

docker run --rm -v ptn-transit:/data ptn-transit:local \
  --root /data --trusted-key "$PUBLIC_KEY_HEX" cities --source-url "$SOURCE_URL"
docker run --rm -v ptn-transit:/data ptn-transit:local \
  --root /data --city "$CITY" --trusted-key "$PUBLIC_KEY_HEX" \
  sync --source-url "$SOURCE_URL" --from-discovery --without-geometry

docker run --name ptn-serve --read-only \
  -v ptn-transit:/data:ro --tmpfs /runtime -p 127.0.0.1:3000:3000 \
  ptn-serve:local --transit-store-root /data \
  --transit-trusted-key "$PUBLIC_KEY_HEX" --city-slug "$CITY" \
  --data-root /runtime --pidfile-path /runtime/serve.pid \
  --listen-addr 0.0.0.0:3000 --page-warm-mode off \
  --max-rss-bytes "$RSS_BUDGET_BYTES" \
  --process-fixed-overhead-bytes "$FIXED_OVERHEAD_BYTES" \
  --per-worker-overhead-bytes "$WORKER_OVERHEAD_BYTES"
```

Set the mirror URL, independently obtained public key, city and measured memory
budgets before running these commands. The API is bound to host loopback; use
it with the matching PWA assets and your hosting proxy. The runtime tmpfs is
separate from the persistent pack volume. The server mounts that volume read
only, while each installer invocation mounts it writable. Keep the volume across
container replacement. Run the same `sync` command to update; the server watcher
observes the atomic activation. Stop concurrent installer invocations rather
than bypassing the writer lock. During a mirror outage the existing installation
continues to serve without an installer or builder container.

To add geometry, repeat `sync` without `--without-geometry`; to remove it, include
the flag again. Both selections must be advertised by the source. Use the same
installer volume and configured keys for `verify`, `pin` and `rollback`. No OSM
container or search dataset is required for this transit-only path.

For builder-side acceptance of a retained city, use the
[transit installation validation harness](transit-pack-validation.md). It checks
both geometry variants and offline serving without changing public deployment.
