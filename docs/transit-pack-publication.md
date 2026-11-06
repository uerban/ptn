# Publishing transit packs

`pt-pack-publish` assembles accepted signed exports into a local static mirror.
It runs on the builder with a signing key. It does not deploy a server, fetch
feeds, run a producer, authorize redistribution, or configure a CDN.

First prepare and accept the immutable exports with `pt-pack-export`, including
both variants when required. Native format validation is necessary, but real-city
closure, routing and constrained-host acceptance remain separate release gates.
Use independently configured publisher public keys, including the current key.

```sh
cargo run -p pt-artifacts --locked --bin pt-pack-publish -- \
  --repository /srv/transit-publisher --city CITY \
  --selection /accepted/CITY-with-geometry \
  --selection /accepted/CITY-without-geometry \
  --expires-at 2026-12-06T00:00:00Z \
  --signing-key /builder-keys/transit-seed.hex --trusted-key PUBLIC_KEY_HEX
```

Choose an expiry appropriate to the promotion cadence; the date above is an
example. One selection is also allowed. Both variants must describe the same
pack and generation, with no duplicate geometry choice. The command prints a
receipt containing the city, allocated sequence, head hash and pack identity.
A renewal of the same accepted exports receives a new sequence and expiry.

Serve **only `/srv/transit-publisher/public`**. Keep the publisher root and its
`private` subtree off the web server. The signing key remains outside the
repository. Retain and back up the private ledger together with the public tree.
The publisher root must be exclusively managed by this tool; it takes an OS
writer lock, and does not follow another publisher's mutable directory layout.

```text
public/transit/objects/sha256/FILE_SHA256
public/transit/selections/SELECTION_SHA256/selection.json
public/transit/selections/SELECTION_SHA256/selection.json.sig
public/transit/catalog/heads/HEAD_SHA256/latest.json
public/transit/catalog/heads/HEAD_SHA256/latest.json.sig
public/transit/catalog/v1/CITY -> ../heads/HEAD_SHA256
private/state/transit-publish-CITY.json
private/state/writer.lock
```

The public root is directly consumable by `pt-transit --source-directory` or an
HTTPS mirror exposing the same paths. The static server must resolve the
publisher-owned relative channel symlink. Never serve the private subtree or
staging files. Treat objects, selections and hashed heads as immutable. The
mutable city alias needs a shorter discovery TTL than immutable content; the
intended production policy is about one day for immutable files and five minutes
for discovery, with the CDN respecting origin TTLs. HTTP configuration and
end-to-end cache verification are separate ops work.

The publisher authenticates every export, validates native data and compares the
complete signed inventory. It streams selected files through bounded hash/size
checks into private staging, and exposes only complete immutable objects and
metadata. Existing objects are rechecked and reused; corrupt immutable files
cause failure rather than in-place repair. Existing descriptor signatures may
be retained during key rotation while their public keys remain trusted. Retiring
a descriptor key requires newly accepted descriptors signed by a trusted key;
re-signing identical descriptor bytes does not change their immutable identity.
Never replace an existing signature in place.

The per-city private ledger reserves the next sequence and exact head hash
before that signed head is exposed. Both head files are written into a complete
immutable directory. One atomic symlink rename then switches the public channel;
completion is recorded in the ledger afterward. A crash before switching leaves
the old channel intact; its reserved sequence is consumed. A crash after
switching is reconciled from the pending ledger entry on the next publication.
Gaps are expected. Sequences are never inferred solely from whatever head files
happen to remain on disk.

If the public head and ledger disagree, or the ledger/head is missing after a
successful publication, the command fails closed. Restore consistent state from
backup rather than deleting the ledger or resetting sequence numbers. An error
late in publication can mean the new head already became public; inspect the
channel and ledger before retrying. Retry reconciles a valid pending completion.
Interrupted private staging is cleaned on the next valid publication attempt.

Clients fetch `latest.json`, then request its signature from the immutable path
using the hash of those exact bytes. This avoids mixing a cached head with a
newer mutable signature. Older mirrors exposing only `latest.json.sig` remain
supported as a fallback; signature, expiry, sequence and descriptor checks still
apply. Keep the immutable head and its signature available while discovery may
be cached. New clients also verify already-cached objects and installed files.

No pruning is enabled. Old objects, descriptors and heads remain available for
cached discovery, rollback and in-flight downloads. Publication is additive and
never rewrites signed pack metadata. Production promotion, retention policy,
space limits, native/Docker packaging and measured low-memory acceptance must
still be integrated before treating this as an accepted public service.
