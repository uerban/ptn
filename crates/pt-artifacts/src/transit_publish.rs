//! Builder-side transit repository assembly. Serve only ROOT/public; keep ROOT/private.
//! Publication is single-writer, reserves sequences durably, and never prunes objects.
use crate::{
    store::{atomic_json, durable_mkdir, Store},
    transit::{self, TransitInventory},
    transit_catalog::{self, Catalog, Checkpoint, Selection},
    transit_export, transit_native,
};
use ed25519_dalek::SigningKey;
use pt_shared::{
    fsync,
    osm_manifest::{digest, timestamp_seconds, valid_digest},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{fd::AsFd, unix::fs::symlink},
    path::{Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

pub struct Publication<'a> {
    pub city: &'a str,
    pub exports: &'a [PathBuf],
    pub expires_at: &'a str,
    pub signing_key: &'a SigningKey,
    pub trusted_keys: &'a [[u8; 32]],
    pub now: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub city: String,
    pub sequence: u64,
    pub head_sha256: String,
    pub pack_id: String,
    pub generation_id: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Ledger {
    pub(crate) schema_version: u32,
    pub(crate) city: String,
    pub(crate) highest_sequence: u64,
    pub(crate) published: Option<Checkpoint>,
    pub(crate) pending: Option<Checkpoint>,
}
struct Export {
    root: PathBuf,
    bytes: Vec<u8>,
    signature: Vec<u8>,
    inventory: TransitInventory,
}
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}
pub(crate) fn bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid("publication metadata exceeds limit"));
    }
    Ok(bytes)
}
pub(crate) fn regular(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() => Ok(true),
        Ok(_) => Err(invalid("immutable publication path must be a regular file")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}
fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    fsync::durable(file.as_fd())
}
pub(crate) fn sync_dir(path: &Path) -> io::Result<()> {
    fsync::durable_dir(File::open(path)?.as_fd())
}
fn same(a: Option<&Checkpoint>, b: Option<&Checkpoint>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a.sequence == b.sequence && a.sha256 == b.sha256,
        (None, None) => true,
        _ => false,
    }
}
fn current(channel: &Path, city: &str, keys: &[[u8; 32]]) -> io::Result<Option<Checkpoint>> {
    match fs::symlink_metadata(channel) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
        Ok(m) if !m.file_type().is_symlink() => {
            return Err(invalid("channel must be publisher-owned symlink"))
        }
        Ok(_) => {}
    }
    let bytes = bounded(
        &channel.join("latest.json"),
        transit_catalog::MAX_CATALOG_BYTES,
    )?;
    let sig = bounded(&channel.join("latest.json.sig"), 64)?;
    let prior: Catalog = serde_json::from_slice(&bytes).map_err(invalid)?;
    // Expired heads can be renewed, but must still authenticate with configured keys.
    let published = timestamp_seconds(&prior.published_at).map_err(invalid)?;
    let prior =
        transit_catalog::verify(&bytes, &sig, keys, city, None, published).map_err(invalid)?;
    let sha256 = digest(&bytes);
    if fs::read_link(channel)? != format!("../heads/{sha256}") {
        return Err(invalid("channel target does not match signed head"));
    }
    Ok(Some(Checkpoint {
        sequence: prior.sequence,
        sha256,
    }))
}
fn refuse_prior_heads_without_ledger(channel: &Path, city: &str) -> io::Result<()> {
    // A lost ledger plus a missing alias is not a new city if its immutable
    // heads remain. Scan only on first publication / missing-ledger recovery.
    let heads = channel.parent().unwrap().parent().unwrap().join("heads");
    let entries = match fs::read_dir(heads) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let prior: Catalog = serde_json::from_slice(&bounded(
            &entry.path().join("latest.json"),
            transit_catalog::MAX_CATALOG_BYTES,
        )?)
        .map_err(invalid)?;
        if prior.city == city {
            return Err(invalid(
                "publication ledger missing while prior heads remain",
            ));
        }
    }
    Ok(())
}
pub(crate) fn ledger(
    path: &Path,
    channel: &Path,
    city: &str,
    keys: &[[u8; 32]],
) -> io::Result<Ledger> {
    let observed = current(channel, city, keys)?;
    if !path.try_exists()? && observed.is_none() {
        refuse_prior_heads_without_ledger(channel, city)?;
    }
    read_ledger(path, city, observed)
}

pub(crate) fn read_ledger(
    path: &Path,
    scope: &str,
    observed: Option<Checkpoint>,
) -> io::Result<Ledger> {
    let mut ledger: Ledger = match bounded(path, 64 * 1024) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(invalid)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound && observed.is_none() => Ledger {
            schema_version: 1,
            city: scope.into(),
            ..Default::default()
        },
        Err(e) => return Err(e),
    };
    if ledger.schema_version != 1
        || ledger.city != scope
        || ledger
            .published
            .iter()
            .chain(ledger.pending.iter())
            .any(|p| {
                p.sequence == 0 || p.sequence > ledger.highest_sequence || !valid_digest(&p.sha256)
            })
        || ledger.pending.as_ref().is_some_and(|p| {
            p.sequence != ledger.highest_sequence
                || ledger
                    .published
                    .as_ref()
                    .is_some_and(|old| old.sequence >= p.sequence)
        })
        || (ledger.highest_sequence > 0 && ledger.published.is_none() && ledger.pending.is_none())
    {
        return Err(invalid("invalid publication ledger"));
    }
    if observed.is_some() && same(observed.as_ref(), ledger.pending.as_ref()) {
        // Crash after public switch, before recording completion. Never rewind it.
        ledger.published = ledger.pending.take();
        atomic_json(path, &ledger)?;
    } else if !same(observed.as_ref(), ledger.published.as_ref()) {
        return Err(invalid("public head and publication ledger disagree"));
    }
    Ok(ledger)
}
pub(crate) fn check_hash(
    reader: &mut impl Read,
    expected: &str,
    size: u64,
    mut output: Option<&mut File>,
) -> io::Result<()> {
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| invalid("object size overflow"))?;
        if total > size {
            return Err(invalid("publication object exceeds signed size"));
        }
        hash.update(&buffer[..count]);
        if let Some(out) = output.as_mut() {
            out.write_all(&buffer[..count])?;
        }
    }
    if total != size || format!("{:x}", hash.finalize()) != expected {
        return Err(invalid("publication object hash/size mismatch"));
    }
    Ok(())
}
fn object(source: &Path, target: &Path, stage: &Path, sha: &str, size: u64) -> io::Result<()> {
    if regular(target)? {
        return check_hash(&mut File::open(target)?, sha, size, None);
    }
    let temporary = stage.join("object");
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    check_hash(&mut File::open(source)?, sha, size, Some(&mut output))?;
    fsync::durable(output.as_fd())?;
    fs::rename(temporary, target)?;
    sync_dir(target.parent().unwrap())
}
pub(crate) fn pair(
    stage: &Path,
    target: &Path,
    name: &str,
    bytes: &[u8],
    sig: &[u8],
) -> io::Result<()> {
    if fs::symlink_metadata(target).is_ok() {
        if !fs::symlink_metadata(target)?.is_dir()
            || bounded(&target.join(name), bytes.len())? != bytes
            || bounded(&target.join(format!("{name}.sig")), 64)? != sig
        {
            return Err(invalid("immutable publication metadata collision"));
        }
        return Ok(());
    }
    let temporary = stage.join("pair");
    durable_mkdir(&temporary)?;
    write(&temporary.join(name), bytes)?;
    write(&temporary.join(format!("{name}.sig")), sig)?;
    sync_dir(&temporary)?;
    fs::rename(&temporary, target)?;
    sync_dir(target.parent().unwrap())
}

/// Publish accepted immutable exports. Only ROOT/public is a static web root.
/// ROOT/private owns the lock, sequence ledger and restartable staging. A crash
/// after the head switch can leave a pending ledger entry; next publication
/// reconciles it. Errors after that switch may mean the new head is already live.
pub fn publish(root: &Path, request: &Publication<'_>) -> io::Result<Receipt> {
    if request.city.is_empty()
        || request.city.len() > 64
        || !request
            .city
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || request.exports.is_empty()
        || request.exports.len() > 2
        || !request
            .trusted_keys
            .contains(&request.signing_key.verifying_key().to_bytes())
    {
        return Err(invalid(
            "invalid transit publication inputs or untrusted publisher key",
        ));
    }
    let time = UNIX_EPOCH
        .checked_add(Duration::from_secs(
            request.now.try_into().map_err(invalid)?,
        ))
        .ok_or_else(|| invalid("invalid publication time"))?;
    let _writer = Store::open(&root.join("private"))?;
    let public = root.join("public/transit");
    let channel = public.join("catalog/v1").join(request.city);
    let ledger_path = root
        .join("private/state")
        .join(format!("transit-publish-{}.json", request.city));
    let mut ledger = ledger(&ledger_path, &channel, request.city, request.trusted_keys)?;
    let mut catalog = Catalog {
        schema_version: 1,
        city: request.city.into(),
        sequence: ledger
            .highest_sequence
            .checked_add(1)
            .ok_or_else(|| invalid("publication sequence overflow"))?,
        pack_id: String::new(),
        generation_id: String::new(),
        published_at: jiff::Timestamp::from_second(request.now)
            .map_err(invalid)?
            .to_string(),
        expires_at: request.expires_at.into(),
        selections: Vec::new(),
    };
    let mut exports = Vec::new();
    for root in request.exports {
        let bytes = bounded(
            &root.join("selection.json"),
            transit_export::MAX_DESCRIPTOR_BYTES,
        )?;
        let signature = bounded(&root.join("selection.json.sig"), 64)?;
        let inventory =
            transit_export::verify(&bytes, &signature, request.trusted_keys, request.city)?;
        if inventory.files.iter().any(|file| {
            file.size_bytes == 0 || file.size_bytes > pt_shared::osm_manifest::MAX_OBJECT_BYTES
        }) {
            return Err(invalid("transit object exceeds installer format limits"));
        }
        let actual =
            transit_native::validate(&root.join("files"), inventory.geometry_selected, time)?;
        if serde_json::to_value(&actual).map_err(invalid)?
            != serde_json::to_value(&inventory).map_err(invalid)?
        {
            return Err(invalid("export files do not match signed selection"));
        }
        if exports.is_empty() {
            catalog.pack_id = inventory.pack_id.clone();
            catalog.generation_id = inventory.generation_id.clone();
        } else if catalog.pack_id != inventory.pack_id
            || catalog.generation_id != inventory.generation_id
        {
            return Err(invalid("transit exports belong to different packs"));
        }
        catalog.selections.push(Selection {
            sha256: digest(&bytes),
            bytes: bytes.len() as u64,
            geometry_selected: inventory.geometry_selected,
        });
        exports.push(Export {
            root: root.clone(),
            bytes,
            signature,
            inventory,
        });
    }
    catalog.selections.sort_by_key(|s| s.geometry_selected);
    let (bytes, sig) =
        transit_catalog::prepare(&catalog, request.signing_key, request.now).map_err(invalid)?;
    let head_sha256 = digest(&bytes);
    let stage = root.join("private/state/transit-publish-staging");
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    durable_mkdir(&stage)?;
    let result = (|| {
        let objects = public.join("objects/sha256");
        let selections = public.join("selections");
        let heads = public.join("catalog/heads");
        for dir in [&objects, &selections, &heads, channel.parent().unwrap()] {
            durable_mkdir(dir)?;
        }
        for export in &exports {
            for artifact in &export.inventory.files {
                let source = transit::file_path(&export.root.join("files"), &artifact.path)?;
                object(
                    &source,
                    &objects.join(&artifact.sha256),
                    &stage,
                    &artifact.sha256,
                    artifact.size_bytes,
                )?;
            }
            let target = selections.join(digest(&export.bytes));
            // A key rotation can retain an existing valid signature over the same
            // descriptor. The immutable URL identifies descriptor bytes, not its key.
            if target.exists() {
                let old = bounded(
                    &target.join("selection.json"),
                    transit_export::MAX_DESCRIPTOR_BYTES,
                )?;
                let old_sig = bounded(&target.join("selection.json.sig"), 64)?;
                transit_export::verify(&old, &old_sig, request.trusted_keys, request.city)?;
                if old != export.bytes {
                    return Err(invalid("immutable selection collision"));
                }
                if !fs::symlink_metadata(&target)?.is_dir() {
                    return Err(invalid("selection must be a directory"));
                }
            } else {
                pair(
                    &stage,
                    &target,
                    "selection.json",
                    &export.bytes,
                    &export.signature,
                )?;
            }
        }
        let checkpoint = Checkpoint {
            sequence: catalog.sequence,
            sha256: head_sha256.clone(),
        };
        // Write-ahead reservation: signed public heads never reuse a sequence,
        // including when publication crashes before the channel switch.
        ledger.highest_sequence = catalog.sequence;
        ledger.pending = Some(checkpoint);
        atomic_json(&ledger_path, &ledger)?;
        pair(
            &stage,
            &heads.join(&head_sha256),
            "latest.json",
            &bytes,
            &sig,
        )?;
        let next = channel.with_extension("next");
        if fs::symlink_metadata(&next).is_ok() {
            fs::remove_file(&next)?;
        }
        symlink(format!("../heads/{head_sha256}"), &next)?;
        fs::rename(&next, &channel)?;
        sync_dir(channel.parent().unwrap())?;
        ledger.published = ledger.pending.take();
        atomic_json(&ledger_path, &ledger)?;
        Ok(Receipt {
            city: request.city.into(),
            sequence: catalog.sequence,
            head_sha256,
            pack_id: catalog.pack_id,
            generation_id: catalog.generation_id,
        })
    })();
    let _ = fs::remove_dir_all(stage);
    result
}
