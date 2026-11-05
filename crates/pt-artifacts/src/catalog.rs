//! The channel's detached Ed25519 signature covers the exact catalog bytes.
//! Trusted public keys come from deployment configuration, never the mirror.
use ed25519_dalek::{Signature, VerifyingKey};
use pt_shared::osm_manifest::valid_digest;
use serde::{Deserialize, Serialize};

pub const MAX_METADATA_BYTES: usize = 1024 * 1024;
const DOMAIN: &[u8] = b"PTN-OSM-CATALOG-v1\0";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub schema_version: u32,
    pub city: String,
    /// Monotonic upstream publication counter. Local rollback never rewinds it.
    pub sequence: u64,
    pub manifest_sha256: String,
    pub manifest_bytes: u64,
    pub published_at: String,
    pub expires_at: String,
}

/// Build the message for signing in the offline publisher as well as verification.
pub fn signing_message(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err("catalog exceeds metadata limit".into());
    }
    let mut message = Vec::with_capacity(DOMAIN.len() + bytes.len());
    message.extend_from_slice(DOMAIN);
    message.extend_from_slice(bytes);
    Ok(message)
}

/// `now` is Unix time from the installer's clock. An expired catalog cannot
/// install new data; already-installed offline data is unaffected by expiry.
pub fn verify(
    bytes: &[u8],
    signature: &[u8],
    trusted_keys: &[[u8; 32]],
    city: &str,
    high_water: u64,
    now: i64,
) -> Result<Catalog, String> {
    let message = signing_message(bytes)?;
    let signature = Signature::from_slice(signature).map_err(|_| "invalid signature encoding")?;
    if !trusted_keys.iter().any(|bytes| {
        VerifyingKey::from_bytes(bytes)
            .is_ok_and(|key| key.verify_strict(&message, &signature).is_ok())
    }) {
        return Err("catalog signature does not match a trusted key".into());
    }
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if catalog.schema_version != 1
        || catalog.city != city
        || catalog.sequence == 0
        || catalog.sequence < high_water
        || !valid_digest(&catalog.manifest_sha256)
        || catalog.manifest_bytes == 0
        || catalog.manifest_bytes > MAX_METADATA_BYTES as u64
    {
        return Err("invalid catalog identity, sequence or bounds".into());
    }
    let published = timestamp(&catalog.published_at)?;
    let expires = timestamp(&catalog.expires_at)?;
    if published > now + 300 || expires <= now || expires <= published {
        return Err("expired or future-dated catalog".into());
    }
    Ok(catalog)
}

fn timestamp(value: &str) -> Result<i64, String> {
    // Use the workspace's timestamp parser through the shared validation helper.
    pt_shared::osm_manifest::timestamp_seconds(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn catalog() -> Catalog {
        Catalog {
            schema_version: 1,
            city: "oslo".into(),
            sequence: 2,
            manifest_sha256: pt_shared::osm_manifest::digest(b"manifest"),
            manifest_bytes: 100,
            published_at: "2026-10-29T00:00:00Z".into(),
            expires_at: "2026-11-29T00:00:00Z".into(),
        }
    }
    #[test]
    fn authenticates_exact_bytes_and_configured_keys() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let bytes = serde_json::to_vec(&catalog()).unwrap();
        let signature = key.sign(&signing_message(&bytes).unwrap()).to_bytes();
        let now = timestamp("2026-10-30T00:00:00Z").unwrap();
        let keys = [key.verifying_key().to_bytes()];
        assert!(verify(&bytes, &signature, &keys, "oslo", 2, now).is_ok());
        assert!(verify(&bytes, &signature, &[], "oslo", 2, now).is_err());
        assert!(verify(&bytes, &signature, &keys, "vilnius", 2, now).is_err());
        assert!(verify(&bytes, &signature, &keys, "oslo", 3, now).is_err());
        let mut tampered = bytes.clone();
        tampered.push(b' ');
        assert!(verify(&tampered, &signature, &keys, "oslo", 2, now).is_err());
        assert!(verify(&bytes, &signature, &keys, "oslo", 2, now + 40 * 86400).is_err());
    }
    #[test]
    fn key_rotation_accepts_either_configured_key() {
        let old = SigningKey::from_bytes(&[7; 32]);
        let new = SigningKey::from_bytes(&[8; 32]);
        let bytes = serde_json::to_vec(&catalog()).unwrap();
        let keys = [
            old.verifying_key().to_bytes(),
            new.verifying_key().to_bytes(),
        ];
        for key in [old, new] {
            let signature = key.sign(&signing_message(&bytes).unwrap()).to_bytes();
            assert!(verify(
                &bytes,
                &signature,
                &keys,
                "oslo",
                0,
                timestamp("2026-10-30T00:00:00Z").unwrap()
            )
            .is_ok());
        }
    }
}
