//! Offline signed transit selections. Outputs are staging directories, not live
//! channels; publish only completed exports after native validation and review.
use crate::transit::{self, TransitInventory};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
};

const DOMAIN: &[u8] = b"PTN-TRANSIT-SELECTION-v1\0";
pub const MAX_DESCRIPTOR_BYTES: usize = 16 * 1024 * 1024;

fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn message(bytes: &[u8]) -> io::Result<Vec<u8>> {
    if bytes.len() > MAX_DESCRIPTOR_BYTES {
        return Err(invalid("transit descriptor exceeds metadata limit"));
    }
    Ok([DOMAIN, bytes].concat())
}

/// Authenticate exact descriptor bytes using independently configured keys.
/// This verifies authorship, not freshness, native formats or installation
/// safety. A channel catalog must separately bind this descriptor and expiry.
pub fn verify(
    bytes: &[u8],
    signature: &[u8],
    keys: &[[u8; 32]],
    city: &str,
) -> io::Result<TransitInventory> {
    let signature = Signature::from_slice(signature).map_err(invalid)?;
    let message = message(bytes)?;
    if !keys.iter().any(|bytes| {
        VerifyingKey::from_bytes(bytes)
            .is_ok_and(|key| key.verify_strict(&message, &signature).is_ok())
    }) {
        return Err(invalid(
            "transit descriptor signature does not match a trusted key",
        ));
    }
    let inventory: TransitInventory = serde_json::from_slice(bytes).map_err(invalid)?;
    if inventory.schema_version != 1
        || inventory.city != city
        || !pt_shared::osm_manifest::valid_digest(&inventory.pack_id)
        || !pt_shared::osm_manifest::valid_digest(&inventory.generation_id)
    {
        return Err(invalid("invalid transit descriptor identity"));
    }
    let mut paths = std::collections::BTreeSet::new();
    let mut total = 0u64;
    for file in &inventory.files {
        pt_shared::pack_manifest::validate_artifact_path(&file.path).map_err(invalid)?;
        if !paths.insert(file.path.as_str()) || !pt_shared::osm_manifest::valid_digest(&file.sha256)
        {
            return Err(invalid("duplicate path or invalid artifact digest"));
        }
        total = total
            .checked_add(file.size_bytes)
            .ok_or_else(|| invalid("descriptor size overflow"))?;
    }
    if total != inventory.selected_bytes
        || !paths.contains("pack.json")
        || !paths.contains("generation.json")
        || !paths.contains("bundle.ptb")
    {
        return Err(invalid(
            "incomplete transit descriptor or invalid total size",
        ));
    }
    Ok(inventory)
}

/// Copy an accepted immutable generation into a new offline staging directory.
/// Rehash the bytes actually copied to detect changes after inspection. Never
/// follow generated symlinks or include unlisted files. The caller must keep
/// the source immutable throughout export. On failure remove only our new dir.
pub fn export(root: &Path, output: &Path, geometry: bool, key: &SigningKey) -> io::Result<String> {
    let inventory = transit::inspect(root, geometry)?;
    let bytes = serde_json::to_vec_pretty(&inventory).map_err(invalid)?;
    let signature = key.sign(&message(&bytes)?).to_bytes();
    let id = format!("{:x}", Sha256::digest(&bytes));
    fs::create_dir(output)?; // Never reuse or modify an existing output.
    let result = (|| {
        for artifact in &inventory.files {
            let mut source = File::open(transit::file_path(root, &artifact.path)?)?;
            let destination = output.join("files").join(&artifact.path);
            fs::create_dir_all(destination.parent().expect("artifact parent"))?;
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = source.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                size = size
                    .checked_add(count as u64)
                    .ok_or_else(|| invalid("artifact size overflow"))?;
                if size > artifact.size_bytes {
                    return Err(invalid("source grew during export"));
                }
                hash.update(&buffer[..count]);
                target.write_all(&buffer[..count])?;
            }
            if size != artifact.size_bytes || format!("{:x}", hash.finalize()) != artifact.sha256 {
                return Err(invalid(format!(
                    "source changed during export: {}",
                    artifact.path
                )));
            }
            target.sync_all()?;
        }
        write_new(&output.join("selection.json.sig"), &signature)?;
        // Descriptor is the completion marker. This tree must not be served
        // while export is running; ops promotes completed immutable trees.
        write_new(&output.join("selection.json"), &bytes)?;
        Ok(id)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(output);
    }
    result
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
