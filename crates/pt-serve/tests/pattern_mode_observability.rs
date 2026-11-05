//! the PatternMode passed to `Generation::from_paths` is recorded on the `Generation` struct and
//! can be read back via the public `pattern_mode` field.

use std::path::PathBuf;

fn tiny_ptb_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/src/ptb/__fixtures__/tiny.ptb")
}

#[test]
fn from_paths_records_the_built_pattern_mode() {
    let gen_off = pt_serve::Generation::from_paths(
        &tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Off,
    )
    .unwrap();
    assert_eq!(gen_off.pattern_mode, pt_core::PatternMode::Off);

    let gen_unb = pt_serve::Generation::from_paths(
        &tiny_ptb_path(),
        None,
        "vilnius".to_string(),
        pt_core::PatternMode::Unbounded,
    )
    .unwrap();
    assert_eq!(gen_unb.pattern_mode, pt_core::PatternMode::Unbounded);
}
