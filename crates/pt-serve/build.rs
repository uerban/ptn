use std::process::Command;

const BACKEND_PACKAGE_JSON: &str = "../../packages/backend/package.json";

fn git_output(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn backend_major_minor() -> (String, String) {
    println!("cargo:rerun-if-changed={BACKEND_PACKAGE_JSON}");
    let package_json = std::fs::read_to_string(BACKEND_PACKAGE_JSON).unwrap_or_else(|error| {
        panic!(
            "packages/backend/package.json must exist for the shared application build-info contract. Open error: {error}"
        )
    });
    let version_re =
        regex::Regex::new(r#"(?m)^\s*"version"\s*:\s*"([0-9]+)\.([0-9]+)\.[^"]+"\s*,?\s*$"#)
            .expect("static regex compiles");
    let captures = version_re.captures(&package_json).unwrap_or_else(|| {
        panic!(
            "semver version field not found in {BACKEND_PACKAGE_JSON}; pt-serve and Node must share its major.minor"
        )
    });
    (captures[1].to_string(), captures[2].to_string())
}

fn normalized_env_sha() -> Option<String> {
    let raw = std::env::var("PT_SERVE_GIT_SHA").ok()?;
    let sha = raw.trim();
    if sha.is_empty() || sha.eq_ignore_ascii_case("unknown") {
        return None;
    }
    if !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) || !(7..=40).contains(&sha.len()) {
        println!(
            "cargo:warning=PT_SERVE_GIT_SHA={sha:?} is not a 7-40 character hex commit SHA; falling back to local git or unknown"
        );
        return None;
    }
    Some(if sha.len() == 40 {
        sha[..8].to_string()
    } else {
        sha.to_string()
    })
}

// Mirrors scripts/app-version.mjs without duplicating its Git walk: CI computes
// the version once and injects PT_VERSION; anything else is a dev build.
fn injected_version() -> Option<String> {
    let raw = std::env::var("PT_VERSION").ok()?;
    let version = raw.trim();
    if version.is_empty() {
        return None;
    }
    let pattern = regex::Regex::new(
        r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev(\+[0-9a-f]{7,40})?)?$",
    )
    .expect("static regex compiles");
    if !pattern.is_match(version) {
        println!(
            "cargo:warning=PT_VERSION={version:?} is not X.Y.N or X.Y.N-dev[+sha]; falling back to a dev version"
        );
        return None;
    }
    Some(version.to_string())
}

fn app_version() -> String {
    injected_version().unwrap_or_else(|| {
        let (major, minor) = backend_major_minor();
        format!("{major}.{minor}.0-dev")
    })
}

fn app_commit() -> String {
    if let Some(sha) = normalized_env_sha() {
        return sha;
    }
    let Some(sha) = git_output(&["rev-parse", "--short", "HEAD"]).filter(|sha| !sha.is_empty())
    else {
        return "unknown".to_string();
    };
    let dirty = git_output(&["status", "--porcelain", "--untracked-files=no"])
        .is_some_and(|status| !status.is_empty());
    if dirty {
        format!("{sha}-dirty")
    } else {
        sha
    }
}

fn emit_git_rerun_inputs() {
    for path in [
        git_output(&["rev-parse", "--git-path", "HEAD"]),
        git_output(&["rev-parse", "--git-path", "index"]),
    ]
    .into_iter()
    .flatten()
    {
        println!("cargo:rerun-if-changed={path}");
    }
}

fn main() {
    // Mirror scripts/build-info.mjs, the production Node/frontend contract:
    // injected PT_VERSION (else major.minor.0-dev), with the same
    // explicit-SHA/local-Git/unknown commit precedence.
    println!("cargo:rustc-env=PT_SERVE_APP_VERSION={}", app_version());
    println!("cargo:rustc-env=PT_SERVE_GIT_SHA={}", app_commit());
    // Stamp local and container builds even when no explicit timestamp is supplied.
    let built_at = std::env::var("PT_SERVE_BUILT_AT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| jiff::Timestamp::now().to_string());
    println!("cargo:rustc-env=PT_SERVE_BUILT_AT={built_at}");
    emit_git_rerun_inputs();
    println!("cargo:rerun-if-env-changed=PT_VERSION");
    println!("cargo:rerun-if-env-changed=PT_SERVE_GIT_SHA");
    println!("cargo:rerun-if-env-changed=PT_SERVE_BUILT_AT");

    // Pin the readiness staleness threshold against the Node export.
    let ts_file = "../../packages/backend/src/health/feedStaleConstants.ts";
    println!("cargo:rerun-if-changed={ts_file}");
    let content = std::fs::read_to_string(ts_file).unwrap_or_else(|e| {
        panic!(
            "packages/backend/src/health/feedStaleConstants.ts must exist for the Rust/Node FEED_STALE_DAYS pin. Open error: {e}"
        )
    });
    let re = regex::Regex::new(r"FEED_STALE_DAYS\s*=\s*(\d+)").expect("static regex compiles");
    let cap = re.captures(&content).unwrap_or_else(|| {
        panic!(
            "FEED_STALE_DAYS export not found in {ts_file}. If the export was renamed, update crates/pt-serve/build.rs in the same change."
        )
    });
    let value: u32 = cap[1]
        .parse()
        .expect("FEED_STALE_DAYS value must parse as u32");
    println!("cargo:rustc-env=NODE_FEED_STALE_DAYS={value}");

    // Pin the GTFS-RT polling cadence against the Node export.
    let ts_defaults = "../../packages/shared/src/constants/defaults.ts";
    println!("cargo:rerun-if-changed={ts_defaults}");
    let content = std::fs::read_to_string(ts_defaults).unwrap_or_else(|e| {
        panic!(
            "packages/shared/src/constants/defaults.ts must exist for the Rust/Node RT_BACKEND_POLL_INTERVAL_MS pin. Open error: {e}"
        )
    });
    let re = regex::Regex::new(r"RT_BACKEND_POLL_INTERVAL_MS\s*=\s*([\d_]+)\s*;")
        .expect("static regex compiles");
    let cap = re.captures(&content).unwrap_or_else(|| {
        panic!(
            "RT_BACKEND_POLL_INTERVAL_MS export not found in {ts_defaults}. If the export was renamed or removed, update crates/pt-serve/build.rs in the same change."
        )
    });
    let value: u64 = cap[1]
        .replace('_', "")
        .parse()
        .expect("RT_BACKEND_POLL_INTERVAL_MS value must parse as u64");
    println!("cargo:rustc-env=NODE_RT_BACKEND_POLL_INTERVAL_MS={value}");

    // Rust consumes the manifest-selected edge, but it independently enforces
    // the canonical k-anonymity floor while validating active corpora.
    let ts_tile_params = "../../packages/shared/src/poi/tileParams.ts";
    println!("cargo:rerun-if-changed={ts_tile_params}");
    let content = std::fs::read_to_string(ts_tile_params).unwrap_or_else(|e| {
        panic!(
            "packages/shared/src/poi/tileParams.ts must exist for the Rust/Node TILE_MIN_K pin. Open error: {e}"
        )
    });
    let re = regex::Regex::new(
        r"(?m)^[ \t]*export[ \t]+const[ \t]+TILE_MIN_K[ \t]*=[ \t]*(\d+)[ \t]*;[ \t]*$",
    )
    .expect("static regex compiles");
    let cap = re.captures(&content).unwrap_or_else(|| {
        panic!(
            "TILE_MIN_K export not found in {ts_tile_params}. If the export was renamed, update crates/pt-serve/build.rs in the same change."
        )
    });
    let value: usize = cap[1].parse().expect("TILE_MIN_K must parse as usize");
    println!("cargo:rustc-env=NODE_TILE_MIN_K={value}");
}
