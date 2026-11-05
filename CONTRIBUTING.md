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

Describe what changed and why, keep PRs to one logical change, and reference
the issue (`Closes #N`) when there is one.

## Questions and security

See [SUPPORT.md](SUPPORT.md). Report vulnerabilities as described in
[SECURITY.md](SECURITY.md), never in a public issue.
