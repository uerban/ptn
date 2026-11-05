# tiny-gtfs fixture

3 stops, 2 routes, 4 trips, 12 stop_times rows. Hand-crafted to exercise:
- IdentityInterner (3 stops, 2 routes, 4 trips, 2 services)
- Pass 1 counts (T1:3, T2:3, T3:3, T4:3 → 12 total)
- Overnight rollover (T4 has 25:30:00, 25:35:00)
- calendar_dates exception (WD removed on 2026-05-20)

To regenerate the zip:

    cd crates/pt-producer/tests/fixtures
    (cd tiny-gtfs && zip -r ../tiny-gtfs.zip *.txt)

The committed `packages/shared/src/ptb/__fixtures__/tiny.ptb` is the producer's
own output for this feed, and `packages/backend/src/gtfs/__fixtures__/bundle.ptb`
is a byte-identical copy of it. CI regenerates both and fails on a diff:

    cargo build --release -p pt-producer --no-default-features --features csv-mmap
    ./target/release/pt-producer --gtfs-path crates/pt-producer/tests/fixtures/tiny-gtfs.zip \
      --out /tmp/tiny.ptb --idle-after-ingestion 0 --anchor-date 20260501 \
      --city-tz-iana Europe/Vilnius --listen-addr 127.0.0.1:0
    cp /tmp/tiny.ptb packages/shared/src/ptb/__fixtures__/tiny.ptb
    cp /tmp/tiny.ptb packages/backend/src/gtfs/__fixtures__/bundle.ptb
    # the producer's *.meta.json / *.shapes.json sidecars are not committed;
    # the backend keeps its own hand-written ones next to bundle.ptb

# canary-gtfs fixture

One route, two trips, two stops with multi-byte UTF-8 ids and names (`Žz`,
`Žalgiris`, `Š1`, `Šiaurė`, `tŠ-1`), a 3-second dwell at `tŠ-1`'s first stop,
and no `direction_id` (both trips decode to the absent sentinel).
The producer builds `packages/shared/src/ptb/__fixtures__/canary.ptb` from it
with the same command as `tiny.ptb` (`canary-gtfs.zip`, `--out /tmp/canary.ptb`).

To regenerate the zip:

    cd crates/pt-producer/tests/fixtures
    (cd canary-gtfs && zip -X ../canary-gtfs.zip *.txt)

# tiny-gtfs-with-shapes fixture

Same 3-stop / 2-route topology as `tiny-gtfs`, plus a `shapes.txt` with two
shapes (`SH_A` on R1's trips T1/T2, `SH_B` on R2's trip T3; T4 has no shape).
Used wherever a test needs a committed feed that carries `shapes.txt` end to
end (producer shape ingestion, backend shapes-artifact tests).

To regenerate the zip:

    cd crates/pt-producer/tests/fixtures
    (cd tiny-gtfs-with-shapes && zip -r ../tiny-gtfs-with-shapes.zip *.txt)

# window400-gtfs fixture

Same topology as `tiny-gtfs` but with `calendar.txt` `start_date=20260601` /
`end_date=20270710` (no `calendar_dates.txt`). Built to exercise the windowDays
PRODUCER derive (Step A.7): emitted by the producer at `--anchor-date 20260619`,
the horizon is `ymd_to_julian(20270710) - ymd_to_julian(20260619) = 386`, so the
derived window is `386 + 14 margin = 400` exactly — `WindowClampEvent::None`
(strict `>`, NOT ClampedHigh). The producer then emits a `0x01 WindowMeta`
region at stride `ceil(400/8) = 50`.

The committed bundle is `packages/shared/src/ptb/__fixtures__/window400.ptb`
(consumed by both `packages/shared/scripts/assert-ptb-cross-parity.ts` and the
producer's `tests/window_emit.rs`). To regenerate it byte-identically:

    cd crates/pt-producer
    cargo run --release --bin pt-producer --no-default-features --features csv-mmap -- \
      --gtfs-path tests/fixtures/window400-gtfs.zip \
      --out ../../packages/shared/src/ptb/__fixtures__/window400.ptb \
      --anchor-date 20260619 \
      --city-tz-iana Europe/Vilnius --city-tz-offset-seconds 7200 \
      --idle-after-ingestion 0 --listen-addr 127.0.0.1:0
    # then discard the *.meta.json / *.shapes.json sidecars (not committed)

I13 — the `--anchor-date 20260619` literal is INTENTIONALLY pinned and will
eventually fall in the past relative to "today". Do NOT "fix" it to today: a
rolling anchor would change the horizon and break the deterministic 400 derive
(and the byte-identical reproducibility the gates assert). To rebuild the feed
zip itself: `(cd window400-gtfs && zip -X ../window400-gtfs.zip *.txt)`.

# manifest_golden.json fixture

Pins `serde_json::to_vec_pretty`'s output to Node's
`JSON.stringify(manifest, null, 2)` byte-for-byte for the
`schedule_tiles::artifacts::write_bundle_manifest` shape (2-space indent,
`": "` after keys, no trailing newline). The `0_0` cell pins JS number
formatting for integral doubles: `JSON.stringify(0)` is `0` (never `0.0`)
and `-0` prints as `0` — the Rust side feeds `0.0`/`-0.0` f64s through
`serialize_js_number` and must byte-match. Regenerate with:

    node -e '
    const manifest = {
      schemaVersion: 1,
      bundleHash: "abc123",
      generatedAt: 1752300000000,
      tileSize: 6000,
      subdivisions: {
        "1_2": { leaves: [ { suffix: "0", bbox: { minLat: 1.5, maxLat: 2.5, minLon: 3.5, maxLon: 4.5 }, compressedBytes: 123, oversized: false } ] },
        "0_0": { leaves: [ { suffix: "2", bbox: { minLat: 0, maxLat: 0.05390377113111174, minLon: -0, maxLon: 0.05390463256446938 }, compressedBytes: 456, oversized: true } ] }
      }
    };
    process.stdout.write(JSON.stringify(manifest, null, 2));
    ' > manifest_golden.json
