# Hosting validation

Examples are tested against matching binaries, PWA assets and data, rather
than copied from old deployment configurations. Linux x86_64 is the first
release target. Additional release targets and their CI gates are documented
in [release platforms](../docs/release-platforms.md). This table records
completed checks, not intended support.

| Check | Status |
|---|---|
| Clean native Rust source build | Passed on macOS ARM64 and Linux x86_64 |
| Clean default WASM + pnpm + PWA build | Passed on macOS ARM64 and Ubuntu x86_64 |
| Extracted archive local OSM build (no source/node_modules) | Passed on macOS ARM64 and Linux x86_64; signed walking, addresses, graph and POI components |
| Fresh data root, current GTFS, Rust-only generation publishing | Passed on macOS ARM64 and Linux x86_64 |
| Native browser route and IndexedDB sync | Passed on both platforms: 1,546 stops, transit itinerary from WASM worker, zero server plan requests |
| Native local-CA HTTPS | Passed on both platforms; certificate verified against the local CA |
| Generation adoption, failed-refresh preservation, restart | Passed on both platforms |
| Linux x86_64 extracted archive | Passed in isolated Linux environment under emulation |
| Compose localhost and local-CA HTTPS | Passed with Compose 5.7.0 against Podman 6.1.4 Docker API; reload, cross-namespace refresh and restart passed |
| Docker Engine on Ubuntu | Passed for v0.1.0: bootstrap, browser HTTP/local-CA HTTPS, reload, cross-namespace refresh and restart |
| Additional ARM and macOS archive matrix | Configured; platform CI results required before publication |
| systemd and other supervisor templates | Excluded until lifecycle validation |
| Public DNS/ACME issuance | Not run; requires a configured public host |

The local results were captured on 2026-11-04. Linux x86_64 local tests used emulation
on an ARM Mac, including an isolated Linux installation with only the extracted
archive, system Python/CA certificates, Caddy, and configured data. This is a
correctness check, not a performance baseline. Rust and pnpm workspace tests,
typecheck, lint, and workflow lint also passed from the clean verification copy.

The [v0.1.0 release workflow](https://github.com/uerban/ptn/actions/runs/42075758129)
passed on Ubuntu/Docker Engine on 2026-11-05. The workflow creates only a draft,
after source builds,
tests, an extracted-archive local OSM build, and native/Compose lifecycle checks.
A release asset contains matching versions of every native tool and the PWA.
The [v0.1.0 release](https://github.com/uerban/ptn/releases/tag/v0.1.0) provides
the validated Linux x86_64 archive.

Browser check, from the source checkout with Playwright installed:

```sh
python3 scripts/hosting-probe.py /absolute/state/directory/vilnius.zip > probe.json
node scripts/verify-hosting.mjs http://localhost:8080 probe.json /tmp/ptn-browser-check
```

The probe selects an actual active trip from the installed feed. The browser
check uses a fresh profile and the real served API, verifies synchronized stops
and a routing worker, requires a result card, and rejects server-side plan
requests. It also checks API/asset 404s and internal-listener isolation.
It blocks external requests during the test. Local-CA browser checks can set
`PTN_TEST_LOCAL_CA=1`; separately verify the certificate with `curl --cacert`.
This flag is not a production TLS setting or proof of public ACME issuance.
