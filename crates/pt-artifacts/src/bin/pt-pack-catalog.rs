use clap::Parser;
use ed25519_dalek::SigningKey;
use pt_artifacts::{
    transit_catalog::{self, Catalog, Selection},
    transit_export,
};
use pt_shared::osm_manifest::{digest, valid_digest};
use std::{
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Parser)]
#[command(
    about = "Prepare a signed offline transit head from authenticated exports; does not publish"
)]
struct Args {
    /// One geometry-free and/or one full export of the same pack.
    #[arg(long, required = true)]
    selection: Vec<PathBuf>,
    #[arg(long)]
    city: String,
    /// Allocate from the publication ledger; must exceed the previous head.
    #[arg(long)]
    sequence: u64,
    /// RFC3339 expiry. Existing installed data is unaffected by head expiry.
    #[arg(long)]
    expires_at: String,
    /// A new, offline output directory. Never serve while preparing.
    #[arg(long)]
    output: PathBuf,
    /// Builder-only Ed25519 32-byte seed as lowercase hex.
    #[arg(long)]
    signing_key: PathBuf,
    /// Configured Ed25519 public keys as lowercase hex, including current key.
    #[arg(long, required = true)]
    trusted_key: Vec<String>,
}
fn decode(value: &str) -> Result<[u8; 32], String> {
    if !valid_digest(value) {
        return Err("expected 32-byte lowercase hex key".into());
    }
    let mut key = [0; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(key)
}
fn bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("metadata exceeds limit"));
    }
    Ok(bytes)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    if args.selection.is_empty() || args.selection.len() > 2 {
        return Err("expected one or two selections".into());
    }
    let key = SigningKey::from_bytes(&decode(fs::read_to_string(args.signing_key)?.trim())?);
    let keys = args
        .trusted_key
        .iter()
        .map(|s| decode(s))
        .collect::<Result<Vec<_>, _>>()?;
    if !keys.contains(&key.verifying_key().to_bytes()) {
        return Err("publisher key is not trusted".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .try_into()?;
    let mut catalog = Catalog {
        schema_version: 1,
        city: args.city,
        sequence: args.sequence,
        pack_id: String::new(),
        generation_id: String::new(),
        published_at: jiff::Timestamp::from_second(now)?.to_string(),
        expires_at: args.expires_at,
        selections: Vec::new(),
    };
    for root in args.selection {
        let bytes = bounded(
            &root.join("selection.json"),
            transit_export::MAX_DESCRIPTOR_BYTES,
        )?;
        let signature = bounded(&root.join("selection.json.sig"), 64)?;
        let inventory = transit_export::verify(&bytes, &signature, &keys, &catalog.city)?;
        // Reinspect exported files as well as signatures. No builders or extras.
        let actual = pt_artifacts::transit_native::validate(
            &root.join("files"),
            inventory.geometry_selected,
            SystemTime::now(),
        )?;
        if serde_json::to_value(&actual)? != serde_json::to_value(&inventory)? {
            return Err("export files no longer match signed selection".into());
        }
        if catalog.selections.is_empty() {
            catalog.pack_id = inventory.pack_id.clone();
            catalog.generation_id = inventory.generation_id.clone();
        } else if catalog.pack_id != inventory.pack_id
            || catalog.generation_id != inventory.generation_id
        {
            return Err("selections belong to different packs or generations".into());
        }
        catalog.selections.push(Selection {
            sha256: digest(&bytes),
            bytes: bytes.len() as u64,
            geometry_selected: inventory.geometry_selected,
        });
    }
    catalog.selections.sort_by_key(|s| s.geometry_selected);
    let (bytes, sig) = transit_catalog::prepare(&catalog, &key, now)?;
    // New offline directory only. A crash may leave staging; never promote a
    // directory without both files and successful signature verification.
    fs::create_dir(&args.output)?;
    let result = (|| -> io::Result<()> {
        fs::write(args.output.join("latest.json.sig"), sig)?;
        fs::write(args.output.join("latest.json"), &bytes)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&args.output);
    }
    result?;
    println!("{}", digest(&bytes));
    Ok(())
}
