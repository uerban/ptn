# Installing transit selections

`pt-transit` installs signed prebuilt transit data without feed downloads,
Java, Node, producer execution or OSM extras. This is the installer layer;
server startup/reload integration is separate work.

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

`verify` prints the selected immutable `files/` directory after validation. This
is not yet a `pt-serve` data root: installer activation does not write producer
pointers or reload a running server. Reading installer activation records from
`pt-serve` is still pending.

For an existing producer data root, `pt-serve --without-geometry` (or
`PT_SERVE_WITHOUT_GEOMETRY=true`) disables shapes loading at startup and on reload.
It skips opening `shapes.bin`, suppresses geometry bodies and their advertised
hashes, and leaves publisher metadata and pack identity unchanged. Other selected
transit artifacts still undergo their normal validation. Geometry is enabled by
default. Pair this with `--page-warm-mode off` when speculative page-in is
undesirable on a constrained host. These runtime flags do not install packs or
change the installer selection; the installed-source adapter must bind runtime
geometry to the activated selection before that mode can be used.

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
