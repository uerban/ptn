# Contributing to PTN

## Setup

Follow the build steps in [README.md](README.md). For a dev server:

```bash
pnpm dev   # frontend at http://localhost:5173
```

## Conventions

- TypeScript in `packages/`, Rust in `crates/`, ESM (`.mjs`) for tooling
- Vitest for TypeScript tests, `cargo test` for Rust
- Tailwind CSS for styling, Zustand for client state
- [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...)

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of Origin](DCO)
1.1, not a CLA. Sign off every commit:

```bash
git commit -s -m "fix(ui): correct countdown drift"
```

To sign off a series you already wrote:
`git rebase --signoff origin/main`.

The engine crates are `MIT OR Apache-2.0`; everything else is
AGPL-3.0-or-later.

## Before opening a PR

```bash
pnpm typecheck
pnpm lint
pnpm test
cargo test --workspace   # when Rust changed
```

For frontend changes, the browser and bundle checks live in `packages/frontend`
(run with `pnpm --filter @pt/frontend <script>`):

| Script | What it runs |
|---|---|
| `e2e:pr` | Core Playwright specs in Chromium and WebKit against the dev server |
| `e2e:offline` | Builds, then runs the offline, Text mode and offline search specs against `vite preview` |
| `e2e:perf` | Measurement specs in `e2e/perf/` (Chromium only, `--project=perf`) |
| `e2e:privacy`, `test:privacy-harness` | Network-privacy specs and per-level request snapshots |
| `size:check` | Chunk-size budgets, and that Text mode starts without MapLibre |

Playwright reads these environment variables:

- `E2E_BASE_URL`: test an already running app at this URL instead of starting one.
- `E2E_PREVIEW=1`: start `vite preview` on the built `dist/` instead of the dev server.
- `E2E_PREVIEW_PORT`: preview port (default 4173), for when another checkout uses it.
- `VITE_E2E=1` (at build time): expose the map inspection handle some specs need
  when run against a production build.

Describe what changed and why, keep PRs to one logical change, and reference
the issue (`Closes #N`) when there is one.

## Questions and security

See [SUPPORT.md](SUPPORT.md). Report vulnerabilities as described in
[SECURITY.md](SECURITY.md), never in a public issue.
