# Compatible dependency security update — 2026-11-06

Full pnpm audit before this update: **26 findings** (1 critical, 8 high,
13 moderate, 4 low). After the compatible updates: **7 findings** (0 critical,
4 high, 2 moderate, 1 low). These are advisory counts, not unique package counts.
The production audit still passes the existing high/critical gate, with its two
moderate findings unchanged. No advisory IDs are ignored or suppressed.

Updated within existing major lines: Vitest/coverage 4.1.12, Vite 6.4.5,
source-map-js 1.2.2, proxy-addr 2.0.8, compression 1.8.2, body-parser 1.20.9,
qs 6.17.1, ip-address 10.7.6 and serialize-javascript 7.1.4. Vitest dependencies
stay aligned and security floors remain bounded to their existing major lines.

Fresh dependency resolution exposed an existing alias mismatch: the frontend
imports `@pt/wasm`, but wasm-pack publishes the workspace package as `pt-wasm`.
Use `workspace:pt-wasm@*` to declare that alias explicitly, preserving the same
local package path and application imports. Frozen installs had reused the old
lockfile link without resolving its package name.

## Remaining findings

| Dependency | Severity/count | Why this PR leaves it unchanged |
| --- | --- | --- |
| extract-zip 2.0.1 | 2 high | Advisory-listed 2.0.2 is not published on npm. Lighthouse/Puppeteer browser tooling still requires this package. |
| basic-ftp 5.3.1 | 1 high | Reported patch starts at 6.2.1; get-uri requires 5.x. Existing override stays below 6. |
| zod 3.25.76 | 1 high | Reported patch starts at 4.6.6; chromium-bidi under the pinned Lighthouse requires 3.x. |
| glob 13.0.6 | 1 moderate | Reported patch starts at 14.0.2. Paths include @fastify/static and Workbox. |
| minimatch 10.2.5 | 1 moderate | Reported patch starts at 11.0.1. Paths include glob, ESLint and TypeScript ESLint. |
| deepmerge 4.3.1 | 1 low | Advisory-listed 4.3.2 is not published on npm. |

Published-version availability was checked directly against npm registry metadata
for [extract-zip](https://registry.npmjs.org/extract-zip) and
[deepmerge](https://registry.npmjs.org/deepmerge). Recheck before the next sweep.
Major upgrades need focused parent-tool upgrades and compatibility validation;
this update does not force them through transitive overrides. A follow-up can
consider Lighthouse CI 0.16/Lighthouse 13 and the affected filesystem consumers.

Advisory records:
[extract-zip 1](https://github.com/advisories/GHSA-jmr9-qjv8-65gv),
[extract-zip 2](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3),
[basic-ftp](https://github.com/advisories/GHSA-c475-qrg2-pj4r),
[zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4),
[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249),
[deepmerge](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).

## Audit status reporting

The full-tree audit remains informational under the existing CI policy. Expected
finding exit codes become a warning and job summary, with the complete JSON
report attached for 14 days. Registry/scanner failures, malformed reports and
inconsistent exit codes fail the job. Production npm high/critical checks and
RustSec checks remain separate blocking steps. A green job therefore means its
blocking audits passed, not that the full development tree is vulnerability-free.
