use clap::Parser;
use ed25519_dalek::SigningKey;
use pt_artifacts::transit_publish::{self, Publication};
use pt_shared::osm_manifest::valid_digest;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Parser)]
#[command(about = "Validate transit exports and publish a complete local static repository")]
struct Args {
    /// Publisher-owned root: serve only ROOT/public; retain and back up ROOT/private.
    #[arg(long)]
    repository: PathBuf,
    /// One full and/or one geometry-free export of the same accepted pack.
    #[arg(long, required = true)]
    selection: Vec<PathBuf>,
    #[arg(long)]
    city: String,
    /// RFC3339 discovery expiry; does not expire installed data or immutable files.
    #[arg(long)]
    expires_at: String,
    /// Builder-only file containing the lowercase hex Ed25519 32-byte seed.
    #[arg(long)]
    signing_key: PathBuf,
    /// Independently configured publisher public keys. Repeat during rotation.
    #[arg(long, required = true)]
    trusted_key: Vec<String>,
}
fn decode(value: &str) -> Result<[u8; 32], String> {
    if !valid_digest(value) {
        return Err("expected 32-byte lowercase hex key".into());
    }
    let mut bytes = [0; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let key = SigningKey::from_bytes(&decode(fs::read_to_string(args.signing_key)?.trim())?);
    let keys = args
        .trusted_key
        .iter()
        .map(|s| decode(s))
        .collect::<Result<Vec<_>, _>>()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .try_into()?;
    let receipt = transit_publish::publish(
        &args.repository,
        &Publication {
            city: &args.city,
            exports: &args.selection,
            expires_at: &args.expires_at,
            signing_key: &key,
            trusted_keys: &keys,
            now,
        },
    )?;
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}
