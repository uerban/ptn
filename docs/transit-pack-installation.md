# Installing transit selections

`pt-transit` installs signed prebuilt transit data without feed downloads,
Java, Node, producer execution or OSM extras. `pt-serve` can consume installed
selections directly.

```sh
cargo run -p pt-artifacts --locked --bin pt-transit -- \
  --root /srv/pt-data --city CITY --trusted-key PUBLIC_KEY_HEX \
  sync --source-url https://mirror.example/ --without-geometry
```

Use `--source-directory /path/to/repository` for an offline local mirror instead
of `--source-url`. Public keys come from operator configuration, not the mirror.
Repeat `--trusted-key` during key rotation. Omit `--without-geometry` to request
the full selection. An unavailable choice fails; it never silently changes the
selection. Both choices retain the publisher's pack ID.

The signed repository layout is:

```text
transit/catalog/v1/CITY/latest.json
transit/catalog/v1/CITY/latest.json.sig
transit/selections/DESCRIPTOR_SHA256/selection.json
transit/selections/DESCRIPTOR_SHA256/selection.json.sig
transit/objects/sha256/FILE_SHA256
```

This layout is the download contract. Offline export/catalog commands prepare
its inputs; a production publisher and atomic public-head promotion are still
pending. Do not expose a partially assembled repository as a supported source.

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
