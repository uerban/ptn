//! Deployment-owned data-root identity, independent of filesystem device/inode.
//!
//! Both processes must receive the same independently configured identity. The
//! identity is not a freshness proof: cloned roots bearing the same identity
//! still need generation/freshness monitoring. Give isolated deployments unique
//! identities. Only explicit binding may initialize an existing root.

use serde::{Deserialize, Serialize};
use std::io::{self, Write};
use std::os::fd::AsFd;
use std::path::Path;

pub const FILENAME: &str = ".data-root-identity.json";
pub const ENV: &str = "PT_DATA_ROOT_ID";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    schema_version: u32,
    data_root_id: String,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn validate(id: &str) -> io::Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err(invalid(
            "data-root identity must be 1..128 ASCII letters, digits, or _.:-",
        ));
    }
    Ok(())
}

fn read(root: &Path) -> io::Result<Option<Identity>> {
    let file = match std::fs::File::open(root.join(FILENAME)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if file.metadata()?.len() > 1024 {
        return Err(invalid("data-root identity file exceeds 1024 bytes"));
    }
    let identity: Identity = serde_json::from_reader(file)
        .map_err(|e| invalid(format!("malformed data-root identity: {e}")))?;
    if identity.schema_version != 1 {
        return Err(invalid("unsupported data-root identity schema"));
    }
    validate(&identity.data_root_id)?;
    Ok(Some(identity))
}

/// False means an unconfigured legacy root. A bound root cannot silently fall
/// back to device/inode verification when its external configuration is lost.
pub fn verify(root: &Path, expected: Option<&str>) -> io::Result<bool> {
    if let Some(expected) = expected {
        validate(expected)?;
    }
    match (read(root)?, expected) {
        (None, None) => Ok(false),
        (None, Some(_)) => Err(invalid("data-root identity missing; run pt-producer bind-data-root before startup")),
        (Some(_), None) => Err(invalid("bound data root requires PT_DATA_ROOT_ID in both producer and server configuration")),
        (Some(actual), Some(expected)) if actual.data_root_id == expected => Ok(true),
        (Some(actual), Some(expected)) => Err(invalid(format!("data-root identity mismatch: expected {expected:?}, found {:?}; refusing a different deployment's root", actual.data_root_id))),
    }
}

pub fn verify_configured(root: &Path) -> io::Result<bool> {
    let expected = std::env::var(ENV).map(Some).or_else(|e| match e {
        std::env::VarError::NotPresent => Ok(None),
        _ => Err(invalid("PT_DATA_ROOT_ID must be UTF-8")),
    })?;
    verify(root, expected.as_deref())
}

/// Caller holds producer.lock. Binding never overwrites an existing identity.
/// Migration requires the independently pinned current generation, so normal
/// startup cannot silently label an arbitrary populated mount as its own.
pub fn bind(root: &Path, id: &str, expected_generation: Option<&str>) -> io::Result<()> {
    validate(id)?;
    let already_bound = read(root)?.is_some();
    if already_bound {
        verify(root, Some(id))?;
        if expected_generation.is_none() {
            return Ok(());
        }
    }
    let current = root.join("current.json");
    if current.exists() {
        let expected = expected_generation.ok_or_else(|| invalid("existing data root requires --expected-generation from the accepted deployment record"))?;
        if expected.len() != 64
            || !expected
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid(
                "expected generation must be 64 lowercase hex characters",
            ));
        }
        let pointer: serde_json::Value =
            serde_json::from_reader(std::fs::File::open(current)?).map_err(invalid_json)?;
        if pointer.get("generationId").and_then(|v| v.as_str()) != Some(expected)
            || !root
                .join("generations")
                .join(expected)
                .join("generation.json")
                .is_file()
        {
            return Err(invalid(
                "current generation does not match the accepted migration generation",
            ));
        }
    } else if expected_generation.is_some()
        || root.join("generations").exists()
        || root.join("last-good.json").exists()
    {
        return Err(invalid(
            "cannot bind a populated or damaged root without its accepted current generation",
        ));
    }
    if already_bound {
        return Ok(());
    }
    let identity = Identity {
        schema_version: 1,
        data_root_id: id.to_owned(),
    };
    let temporary = root.join(format!("{FILENAME}.tmp"));
    let mut file = std::fs::File::create(&temporary)?;
    serde_json::to_writer(&mut file, &identity).map_err(invalid_json)?;
    file.write_all(b"\n")?;
    crate::fsync::durable(file.as_fd())?;
    std::fs::rename(temporary, root.join(FILENAME))?;
    crate::fsync::durable_dir(std::fs::File::open(root)?.as_fd())?;
    Ok(())
}

fn invalid_json(error: serde_json::Error) -> io::Error {
    invalid(format!("invalid identity or migration JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_survives_copy_to_a_new_inode_and_path() {
        let first = tempfile::tempdir().unwrap();
        let restored = tempfile::tempdir().unwrap();
        bind(first.path(), "release-1:vilnius", None).unwrap();
        std::fs::copy(first.path().join(FILENAME), restored.path().join(FILENAME)).unwrap();
        assert!(verify(restored.path(), Some("release-1:vilnius")).unwrap());
    }

    #[test]
    fn wrong_root_and_missing_configuration_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        bind(root.path(), "release-1:vilnius", None).unwrap();
        assert!(verify(root.path(), Some("release-2:vilnius")).is_err());
        assert!(verify(root.path(), None).is_err());
        assert!(bind(root.path(), "release-2:vilnius", None).is_err());
        assert!(verify(root.path(), Some("release-1:vilnius")).unwrap());
    }

    #[test]
    fn missing_or_corrupt_identity_is_not_accepted_when_configured() {
        let root = tempfile::tempdir().unwrap();
        assert!(!verify(root.path(), None).unwrap());
        assert!(verify(root.path(), Some("release-1:vilnius")).is_err());
        std::fs::write(root.path().join(FILENAME), b"{}").unwrap();
        assert!(verify(root.path(), Some("release-1:vilnius")).is_err());
        assert!(bind(root.path(), "release-1:vilnius", None).is_err());
    }

    #[test]
    fn migration_requires_the_accepted_generation_and_preserves_it() {
        let root = tempfile::tempdir().unwrap();
        let generation = "a".repeat(64);
        let pointer = format!("{{\"generationId\":\"{generation}\"}}");
        std::fs::write(root.path().join("current.json"), &pointer).unwrap();
        let directory = root.path().join("generations").join(&generation);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("generation.json"), b"{}").unwrap();
        assert!(bind(root.path(), "release-1:vilnius", None).is_err());
        assert!(bind(root.path(), "release-1:vilnius", Some(&"b".repeat(64))).is_err());
        assert!(!root.path().join(FILENAME).exists());
        bind(root.path(), "release-1:vilnius", Some(&generation)).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("current.json")).unwrap(),
            pointer
        );
        let original = std::fs::read(root.path().join(FILENAME)).unwrap();
        bind(root.path(), "release-1:vilnius", None).unwrap();
        assert_eq!(std::fs::read(root.path().join(FILENAME)).unwrap(), original);
        assert!(bind(root.path(), "release-1:vilnius", Some(&"b".repeat(64))).is_err());
    }

    #[test]
    fn damaged_or_unsupported_roots_are_never_automatically_bound() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("generations")).unwrap();
        assert!(bind(root.path(), "release-1:vilnius", None).is_err());
        assert!(!root.path().join(FILENAME).exists());
        std::fs::write(
            root.path().join(FILENAME),
            br#"{"schemaVersion":2,"dataRootId":"release-1:vilnius"}"#,
        )
        .unwrap();
        assert!(verify(root.path(), Some("release-1:vilnius")).is_err());
        assert!(bind(root.path(), "release-1:vilnius", None).is_err());
        assert!(verify(root.path(), Some("bad\nidentity")).is_err());
    }
}
