# Staging GTFS feed snapshots

No real GTFS snapshot is committed in this directory. The former Vilnius,
Tricity, and three-feed Krakow zips were removed in `6ac422f5`; CI now resolves
private, SHA-256-pinned inputs through the feed artifact register.

Do not add replacement feed zips here. A test fixture committed to Git is a
redistributed copy even when it is not an end-user product. Review the
data-source register, keep restricted
inputs in approved private storage, and fetch plus hash-verify them only in
trusted automation.

The final public-history rewrite must still remove these historical paths from
every ref:

- `packages/backend/tests/fixtures/staging-feeds/vilnius.gtfs.zip`
- `packages/backend/tests/fixtures/staging-feeds/tricity.gtfs.zip`
- `packages/backend/tests/fixtures/staging-feeds/krakow-A.gtfs.zip`
- `packages/backend/tests/fixtures/staging-feeds/krakow-M.gtfs.zip`
- `packages/backend/tests/fixtures/staging-feeds/krakow-T.gtfs.zip`
