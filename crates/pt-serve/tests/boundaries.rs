//! Module-boundary assertions for `pt-serve`.
//!
//!
//! 1. `tiny_http` is confined to `src/http/` (and `main.rs`). Every other
//!    module must be transport-agnostic so the http shell can be swapped
//!    (e.g., a future bench harness driving handlers directly) without
//!    rewriting handlers.
//!
//! 2. Request handlers in `src/app/` take `&Generation`, not `Arc<Generation>`. An ambient
//! `Arc<Generation>` clone in a handler would pin the previous generation across a hot-reload swap,
//! defeating the lock-free reload contract. The dispatcher loads the `Arc` once at the seam and
//! hands `&Generation` down.
//!
//! 3. `arc_swap::ArcSwap::load_full` is restricted to a tight whitelist of
//!    seam files. Clippy enforces the same rule (`disallowed-methods` in the
//!    workspace `clippy.toml`); keeping a source-text grep as well means the
//!    boundary is checked even when clippy is skipped.
//!
//! 4. `pt-serve/src/bundle/loader.rs` does not duplicate structural validation that lives in
//! `pt_core::validate::structural`. The loader is the per-Generation entry point; structural checks
//! (magic-bytes, region bounds, CSR bounds) belong on the engine side so a single source of truth
//! covers both server and bench paths.

use std::path::Path;
use walkdir::WalkDir;

/// `tiny_http` types / imports must appear only under `src/http/`.
///
/// We strip line-comments before checking so doc-comment narrative
/// (e.g. `/// the http→app seam materialises Resp into tiny_http::ResponseBox`)
/// does not register as a leak.
#[test]
fn tiny_http_imports_only_under_http_module() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in WalkDir::new(&src).into_iter().filter_map(|e| e.ok()) {
        if entry.path().extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let rel = entry.path().strip_prefix(&src).unwrap();
        if rel.starts_with("http") {
            continue;
        }
        // `main.rs` is allowed to import tiny_http for the server bind; it is
        // a thin shell over the lib and not part of any non-http module.
        if rel == Path::new("main.rs") {
            continue;
        }
        let content = std::fs::read_to_string(entry.path()).unwrap();
        for (i, line) in content.lines().enumerate() {
            // Drop line-comment tail (handles both `//` and `///` because the
            // `///` doc prefix begins with `//`, so split-at-first-`//` zeroes
            // the doc payload).
            let code = line.split("//").next().unwrap_or("");
            assert!(
                !code.contains("use tiny_http") && !code.contains("tiny_http::"),
                "tiny_http leaked into {}:{} — {}",
                rel.display(),
                i + 1,
                line.trim()
            );
        }
    }
}

/// Handlers under `src/app/` must take `&Generation` (a borrow), not
/// `Arc<Generation>`. We parse each file with `syn` and inspect every `fn`'s
/// argument types as rendered text. Matching against the textual form
/// `Arc < Generation` is robust to whitespace because `quote` normalises
/// spacing around `<` / `>`.
#[test]
fn handlers_take_borrowed_generation_not_arc() {
    let app = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/app");
    for entry in WalkDir::new(&app).into_iter().filter_map(|e| e.ok()) {
        if entry.path().extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let src = std::fs::read_to_string(entry.path()).unwrap();
        let file = syn::parse_file(&src).unwrap();
        for item in file.items {
            let syn::Item::Fn(f) = item else { continue };
            for arg in f.sig.inputs.iter() {
                let syn::FnArg::Typed(pat) = arg else {
                    continue;
                };
                let ty = pat.ty.as_ref();
                let ty_text = quote::quote!(#ty).to_string();
                assert!(
                    !ty_text.contains("Arc < Generation"),
                    "handler {} takes Arc<Generation> — ty: {}",
                    f.sig.ident,
                    ty_text
                );
            }
        }
    }
}

/// `arc_swap::ArcSwap::load_full` is the http↔app seam: the dispatcher loads
/// an owned `Arc<Generation>` once per request, then hands `&Generation` down.
/// Any other call site risks pinning the previous generation against a swap.
///
/// The whitelist covers the HTTP dispatcher and adapter, reload runner, and
/// `ServerCtx::current_generation`, which provides the request snapshot.
///
/// Files NOT on the whitelist may still call `load_full` if the line above
/// carries the explicit `// allow-ambient-arc: <reason>` opt-out marker.
#[test]
fn arc_load_full_only_in_whitelist() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let whitelist = [
        "http/server.rs",
        "http/adapter.rs",
        "reload/runner.rs",
        "ops/server_ctx.rs",
        "ops/metrics.rs",
    ];
    for entry in WalkDir::new(&src).into_iter().filter_map(|e| e.ok()) {
        if entry.path().extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if whitelist.iter().any(|w| rel.contains(w)) {
            continue;
        }
        let content = std::fs::read_to_string(entry.path()).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            // Ignore doc/line-comment mentions; only real code calls.
            let code = line.split("//").next().unwrap_or("");
            if !code.contains("load_full") {
                continue;
            }
            let prev = i
                .checked_sub(1)
                .and_then(|j| lines.get(j))
                .copied()
                .unwrap_or("");
            assert!(
                prev.contains("// allow-ambient-arc:"),
                "load_full() outside whitelist at {}:{} without // allow-ambient-arc: marker",
                rel,
                i + 1
            );
        }
    }
}

/// Structural validation (magic-bytes, region bounds, CSR bounds) belongs on the engine side in
/// `pt_core::validate::structural` so a single source of truth covers the server load path AND the
/// bench / differential paths. The per-Generation loader at `src/bundle/loader.rs` may call the
/// engine's validator but must not re-implement it.
///
#[test]
fn no_duplicated_structural_validation_in_bundle_loader() {
    let loader_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bundle/loader.rs");
    if !loader_path.exists() {
        // The test will activate automatically once the file appears (no separate enabling toggle).
        return;
    }
    let loader = std::fs::read_to_string(&loader_path).unwrap();
    for forbidden in [
        "magic_bytes_check",
        "validate_region_bounds",
        "check_csr_bounds",
    ] {
        assert!(
            !loader.contains(forbidden),
            "structural validation symbol `{}` in bundle/loader.rs — must live in pt-core::validate::structural",
            forbidden
        );
    }
}
