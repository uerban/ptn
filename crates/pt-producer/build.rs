fn main() {
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-env-changed=PT_PRODUCER_GIT_SHA");
    // Honour an explicit override from the build environment (Docker passes
    // --build-arg PT_PRODUCER_GIT_SHA=${{ github.sha }} through to the Rust stage).
    // If unset, fall back to `git rev-parse HEAD` so local builds still carry
    // provenance. If even that fails (no git tree available — e.g. inside a
    // Docker build context that copies the crate without .git), use "unknown"
    // so the build never breaks on missing provenance.
    let sha = std::env::var("PT_PRODUCER_GIT_SHA")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        String::from_utf8(o.stdout)
                            .ok()
                            .map(|s| s.trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| "unknown".to_string())
        });
    println!("cargo:rustc-env=PT_PRODUCER_GIT_SHA={sha}");
}
