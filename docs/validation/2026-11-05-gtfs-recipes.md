# Source-driven refresh validation, 2026-11-05

Local candidate validation for the new release runtime in `examples/native/gtfs.py`.
Final runtime SHA-256: `9eb7e678d6e83978dbf48dd5618fec6b2c3d0159414051e4c74c6c654997979b`.
Community recipes: pt-feeds commit `14939ab` (46 tests and both GitHub checks passed:
[Check](https://github.com/uerban/pt-feeds/actions/runs/42101434186),
[Feed quality](https://github.com/uerban/pt-feeds/actions/runs/42101434195)).
These results do not establish Docker/native full-host lifecycle acceptance or
production deployment. Existing release hosting results predate this change.

- 28 Python tests: source failure/partial fetch preservation, conditional HTTP,
  cached-byte corruption, pinned archive rejection/offline reuse, authenticated
  redirect token redaction, archive traversal/symlink refusal, calendar removals/expiry, namespace references, original-vs-prepared
  validation policy, rolling retention and archive contents/checksums.
- 46 pt-feeds tests: includes all eight recipe catalog/component contracts and
  missing TTC credential refusal.
- 327 producer library tests and 16 CLI/multi-feed integration tests passed.
- Real canonical validator 8.0.1, pinned SHA-256:
  `19293ddd9b6f954f216d4f12054bd8a3232921751c4484339e339764a91000e2`.
- Synthetic HTTPS integration with the actual validator passed raw mode,
  downloaded pinned recipe mode, two colliding component namespaces,
  informational original errors, unchanged preparation reuse, and source failure
  preserving the prior validated candidate. It is now required in release CI.
- The same synthetic acceptance passed inside Linux x86_64 Alpine 3.23 with
  Python, timezone data and OpenJDK21.0.13, using Podman6.1.4 through its Docker
  API under local emulation. This validates the new feed runtime, not the full
  Compose/browser lifecycle.
- Actual two-component `republish` produced one generation with two services,
  after obtaining the reader sentinel from the matching public-branch server.
  Synthetic loop/overnight input only; no city OSM/browser acceptance claimed.
- Ruff checks, workflow actionlint and diff whitespace checks passed.

The public release checkout has no `ptn-dev` helper; checks used its direct
Python/Cargo/package commands. Local HTTPS used the machine's trusted CA bundle
for Python; certificate verification remained enabled.

## Live inputs

All feeds below passed prepared canonical validation and upcoming service
coverage through the new runner. Kraków and Tricity were namespaced before the
prepared canonical check. Warsaw additionally passed its independent full-date
schedule/alias verifier. OSM matching was not required.

| City/mode | Component | Raw SHA-256 | Prepared SHA-256 |
|---|---|---|---|
| Tallinn raw URL | raw | `858f557661ab707e9c2118044e0753b2ee03104167d6e6794b995b7bcbf848ad` | `858f557661ab707e9c2118044e0753b2ee03104167d6e6794b995b7bcbf848ad` |
| riga | rigassatiksme | `c1aa942d1b583b3972b28e4af828b08f17ac1386213196d6c601f8a9d987290b` | `84e6c02ed38189833f82863c4690f56103c14cb7c88340482e09362d0c961f0c` |
| tricity | gdansk | `a80ab684bde91b7c2106eeed16bba3770c2511bc7133812fed18d94ad50dd6da` | `4a9c0b4e5b5a2e3bfd74946489977cfc18947bda79fa0ad6e14473e217d9c107` |
| tricity | gdynia | `61f5a828aa4f1b59bf5c0bad77fdaf1916425dfffd4562def5c0d8976f95b70d` | `8556c32c8eb92fd74e13184ae2a856184f2fef69143efbdff8646ced2e559837` |
| tricity | skm | `91168772e9b9035cc69b29a65a2d80a5d9f9a607fb2e9fbeffeb3332e7ab4d34` | `dcf0f28aa2fb49a4eb92e45b6a62bbdcdb7940341ca0173796920ece332297d8` |
| krakow | ztp-a | `935ee803eea9f7afa112a6e2651992a16a0d56a841358322d590db5358de4afd` | `30b7f8809b483c63f2d828ce5983edfe05d6ec206ea32a6bbb3c925a014e290f` |
| krakow | ztp-m | `dcd8b9210d7cba351f5d4d79c87bacaeea52d86c981fa8a4ee2414791029f579` | `0c3ad7d5f0ac8f6969f7bc2226bb693e440d4154116bd4b9b5d0b817f5764e77` |
| krakow | ztp-t | `adc1b6039d7ad4dcfccee925878385a9a06b3805f5bc26f65f182e32018c0202` | `55fdbbffd8889451434ea2228adffc16b3bf245c9e5a7678fb9f27a3af95e2ba` |
| warsaw | mkuran-wtp | `ca741522670ef875ab0219fbc6e4bf1224f0045e2983697584d1564d42f33176` | `4ffbbc9a5110c62dc1aa146b06b0113f124c250b7ff8804917fec752fe391647` |

Riga selected the official October resource published today:
https://data.gov.lv/dati/dataset/6d78358a-0095-4ce3-b119-6cde5d0ac54f/resource/2e3e9182-f294-48e5-a133-b45cec6ceda4/download/marsrutusaraksti10_2026.zip
It passed the existing explicit unknown-column normalizer; a subsequent source
check returned HTTP304 using hash-verified retained bytes.

Real recipe tests used an archive of the local candidate pt-feeds tree with
SHA-256 `12dd5f132e5c961e1c7bf11fdd7a77f4b78c7b24e878e6e3a564908f9e0af746`.
This is test provenance, not a promoted recipe archive. Operators must review and
pin the committed archive they actually deploy. Runtime tests retained raw feeds,
recipe source, original/prepared reports and manifests locally under
`/private/tmp/ptn-refresh-evidence`; no real feed bytes are committed to Git.

## Outstanding release acceptance

- Run the changed native and Docker host lifecycle in release CI. The Docker
  image now needs Java 21 and timezone data; old hosting results cannot approve
  this dependency change.
- Complete an authenticated Tbilisi recipe run (`TTC_API_KEY` absent locally).
  The quoting-only snapshot is not complete metro acceptance.
- Enable source-aware realtime conversion before attaching upstream realtime to
  namespaced multi-feed IDs; unscoped host configuration is refused.
- Register additional cities in the PWA/proxy and validate their OSM/walking,
  browser routing, capacity, production cadence, monitoring and rollback.
