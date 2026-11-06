use std::process::Command;

#[test]
fn producer_refuses_wrong_root_without_rebinding_or_publishing() {
    let root = tempfile::tempdir().unwrap();
    let binary = env!("CARGO_BIN_EXE_pt-producer");
    let binding = Command::new(binary)
        .args([
            "bind-data-root",
            "--data-root",
            root.path().to_str().unwrap(),
            "--identity",
            "previous:vilnius",
        ])
        .output()
        .unwrap();
    assert!(binding.status.success(), "{:?}", binding);
    let original =
        std::fs::read(root.path().join(pt_shared::data_root_identity::FILENAME)).unwrap();
    let feed = root.path().join("invalid.zip");
    std::fs::write(&feed, b"not a GTFS zip").unwrap();
    let result = Command::new(binary)
        .env(pt_shared::data_root_identity::ENV, "active:vilnius")
        .args([
            "republish",
            "--data-root",
            root.path().to_str().unwrap(),
            "--city",
            "vilnius",
            "--from-cache",
            feed.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(stderr.contains("data-root identity mismatch"), "{stderr}");
    assert_eq!(
        std::fs::read(root.path().join(pt_shared::data_root_identity::FILENAME)).unwrap(),
        original
    );
    assert!(!root.path().join("current.json").exists());
    assert!(!root.path().join("generations").exists());
    assert!(!root.path().join(".producer-data-root-id").exists());
}
